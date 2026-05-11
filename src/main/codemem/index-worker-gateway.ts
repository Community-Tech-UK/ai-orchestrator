/**
 * IndexWorkerGateway — main-process gateway to the codemem index worker.
 *
 * Owns the lifecycle of the index-worker-main.ts worker thread. Routes
 * warm-workspace requests as RPC with per-call timeouts so that slow indexing
 * never blocks the Electron main event loop. Handles worker crash with a
 * single restart attempt; on second crash, stays in degraded mode and all
 * warm-workspace requests return { indexed: false }.
 *
 * Follows the LspWorkerGateway pattern (injectable workerFactory for testing).
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type {
  IndexWorkerInboundMsg,
  IndexWorkerOutboundMsg,
  WarmWorkspaceResult,
} from './index-worker-protocol';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 1;

// ── Types ──────────────────────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface IndexWorkerGatewayOptions {
  rpcTimeoutMs?: number;
  workerFactory?: (userDataPath: string) => Worker;
  userDataPath?: string;
}

export interface IndexWorkerMetrics {
  inFlight: number;
  processed: number;
  dropped: number;
  lastError: string | null;
  degraded: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

function makeWorker(userDataPath: string): Worker {
  const jsEntry = path.join(__dirname, 'index-worker-main.js');
  if (existsSync(jsEntry)) {
    return new Worker(jsEntry, { workerData: { userDataPath } });
  }
  const tsEntry = path.join(__dirname, 'index-worker-main.ts');
  return new Worker(tsEntry, {
    workerData: { userDataPath },
    execArgv: ['--import', 'tsx'],
  });
}

// ── IndexWorkerGateway ────────────────────────────────────────────────────────

export class IndexWorkerGateway {
  private worker: Worker | null = null;
  private rpcId = 0;
  private pending = new Map<number, PendingRpc>();
  private isDegraded = false;
  private restartAttempts = 0;
  private readonly defaultRpcTimeoutMs: number;
  private readonly workerFactory: (userDataPath: string) => Worker;
  private readonly userDataPath: string;
  private metrics = { processed: 0, dropped: 0, lastError: null as string | null };

  constructor(options: IndexWorkerGatewayOptions = {}) {
    this.defaultRpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? makeWorker;
    this.userDataPath =
      options.userDataPath ?? getElectronUserDataPath() ?? '/tmp/ai-orchestrator';
  }

  async start(): Promise<void> {
    if (this.worker) return;
    this.startWorker();
  }

  async stop(): Promise<void> {
    this.failAllPending(new Error('shutdown'));
    if (this.worker) {
      try {
        await this.postRpc({ type: 'shutdown', id: this.nextId() });
      } catch {
        // best-effort
      }
      await this.worker.terminate().catch(() => undefined);
      this.worker = null;
    }
  }

  getMetrics(): IndexWorkerMetrics {
    return {
      inFlight: this.pending.size,
      processed: this.metrics.processed,
      dropped: this.metrics.dropped,
      lastError: this.metrics.lastError,
      degraded: this.isDegraded,
    };
  }

  /**
   * Request the worker to index the workspace and start a file watcher.
   * Returns { indexed: false } when the gateway is degraded or the RPC times out.
   * Never rejects.
   */
  async warmWorkspace(
    workspacePath: string,
    timeoutMs?: number,
  ): Promise<WarmWorkspaceResult> {
    const degradedResult: WarmWorkspaceResult = {
      indexed: false,
      absPath: workspacePath,
      primaryLanguage: 'typescript',
    };

    if (this.isDegraded || !this.worker) {
      return degradedResult;
    }

    const id = this.nextId();
    const result = await this.postRpc(
      { type: 'warm-workspace', id, workspacePath },
      timeoutMs,
    );
    return (result as WarmWorkspaceResult | null) ?? degradedResult;
  }

  /**
   * Ask the worker to stop watching a workspace (fire-and-forget).
   */
  stopWorkspaceWatcher(workspacePath: string): void {
    if (!this.worker) return;
    const msg: IndexWorkerInboundMsg = { type: 'stop-workspace-watcher', workspacePath };
    try {
      this.worker.postMessage(msg);
    } catch {
      // ignore
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private nextId(): number {
    return ++this.rpcId;
  }

  private startWorker(): void {
    if (this.worker) return;
    try {
      const w = this.workerFactory(this.userDataPath);
      w.on('message', (msg: IndexWorkerOutboundMsg) => this.handleMessage(msg));
      w.on('error', (err) => this.handleWorkerError(err));
      w.on('exit', (code) => {
        if (code !== 0) {
          this.handleWorkerError(new Error(`Index worker exited with code ${code}`));
        }
      });
      this.worker = w;
    } catch (err) {
      this.markDegraded(err instanceof Error ? err.message : String(err));
    }
  }

  private handleMessage(msg: IndexWorkerOutboundMsg): void {
    if (msg.type !== 'rpc-response') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(msg.id);
    this.metrics.processed++;
    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result ?? null);
    }
  }

  private handleWorkerError(err: Error): void {
    this.metrics.lastError = err.message;
    this.failAllPending(err);
    this.worker = null;
    this.markDegraded(err.message);
    if (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.restartAttempts++;
      setTimeout(() => {
        this.isDegraded = false;
        this.startWorker();
      }, RESTART_BACKOFF_MS);
    }
  }

  private markDegraded(reason: string): void {
    this.isDegraded = true;
    this.metrics.lastError = reason;
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private postRpc(msg: IndexWorkerInboundMsg & { id: number }, timeoutMs?: number): Promise<unknown> {
    if (!this.worker) return Promise.resolve(null);
    const effectiveTimeout = timeoutMs ?? this.defaultRpcTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.id);
        this.metrics.dropped++;
        resolve(null);
      }, effectiveTimeout);
      this.pending.set(msg.id, { resolve, reject, timeout });
      try {
        this.worker!.postMessage(msg);
      } catch {
        clearTimeout(timeout);
        this.pending.delete(msg.id);
        resolve(null);
      }
    });
  }
}
