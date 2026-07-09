/**
 * IndexWorkerGateway — main-process gateway to the codemem index worker.
 *
 * Owns the lifecycle of the index-worker-main.ts child process. Routes
 * warm-workspace requests as RPC with per-call timeouts so that slow indexing
 * never blocks the Electron main event loop. Handles worker crash with a
 * single restart attempt; on second crash, stays in degraded mode and all
 * warm-workspace requests return { indexed: false }.
 *
 * Follows the LspWorkerGateway pattern (injectable workerFactory for testing).
 */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createIsolatedWorkerProcess, type IsolatedWorkerProcess } from '../runtime/isolated-worker-process';
import type {
  CodeIndexStatusSnapshot,
  CodememMaintenanceSnapshot,
  IndexWorkerInboundMsg,
  IndexWorkerOutboundMsg,
  WarmWorkspaceResult,
} from './index-worker-protocol';
import type { WorkspaceChunkSearchResponse } from './workspace-chunk-search';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_MAINTENANCE_TIMEOUT_MS = 10 * 60 * 1000;
// Searches sit on the create/send hot path — bound them tightly so a busy or
// degraded worker never holds up prompt assembly; the caller falls back to ripgrep.
const DEFAULT_SEARCH_TIMEOUT_MS = 2_500;
const RESTART_BACKOFF_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 1;

// ── Types ──────────────────────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export type IndexWorkerProcessHandle =
  IsolatedWorkerProcess<IndexWorkerInboundMsg, IndexWorkerOutboundMsg>;

export interface IndexWorkerGatewayOptions {
  rpcTimeoutMs?: number;
  workerFactory?: (userDataPath: string) => IndexWorkerProcessHandle;
  userDataPath?: string;
}

export interface IndexWorkerMetrics {
  inFlight: number;
  processed: number;
  dropped: number;
  lastError: string | null;
  degraded: boolean;
}

export interface IndexWorkerCodeIndexChangedEvent {
  workspacePath: string;
  workspaceHash: string;
  paths: string[];
  timestamp: number;
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

function makeWorker(userDataPath: string): IndexWorkerProcessHandle {
  const jsEntry = path.join(__dirname, 'index-worker-main.js');
  const entry = existsSync(jsEntry) ? jsEntry : path.join(__dirname, 'index-worker-main.ts');
  return createIsolatedWorkerProcess<IndexWorkerInboundMsg, IndexWorkerOutboundMsg>({
    name: 'index worker child process',
    entrypoint: entry,
    env: { AIO_USER_DATA_PATH: userDataPath },
  });
}

// ── IndexWorkerGateway ────────────────────────────────────────────────────────

export class IndexWorkerGateway extends EventEmitter {
  private worker: IndexWorkerProcessHandle | null = null;
  private rpcId = 0;
  private pending = new Map<number, PendingRpc>();
  private isDegraded = false;
  private restartAttempts = 0;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly defaultRpcTimeoutMs: number;
  private readonly workerFactory: (userDataPath: string) => IndexWorkerProcessHandle;
  private readonly userDataPath: string;
  private metrics = { processed: 0, dropped: 0, lastError: null as string | null };

  constructor(options: IndexWorkerGatewayOptions = {}) {
    super();
    this.defaultRpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? makeWorker;
    this.userDataPath =
      options.userDataPath ?? getElectronUserDataPath() ?? '/tmp/ai-orchestrator';
  }

  async start(): Promise<void> {
    if (this.worker) return;
    this.shuttingDown = false;
    this.startWorker();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
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
    try {
      const result = await this.postRpc(
        { type: 'warm-workspace', id, workspacePath },
        timeoutMs,
        () => this.cancelIndexFireAndForget(workspacePath),
      );
      return (result as WarmWorkspaceResult | null) ?? degradedResult;
    } catch (error) {
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      return degradedResult;
    }
  }

  /**
   * Run an indexed BM25 chunk search in the worker (off the main thread).
   * Returns null when the gateway is degraded or the search times out, so the
   * caller can fall back to ripgrep; returns `{ indexed: false }` when the
   * workspace has no index yet.
   */
  async searchWorkspaceChunks(
    workspacePath: string,
    query: string,
    limit: number,
    timeoutMs: number = DEFAULT_SEARCH_TIMEOUT_MS,
  ): Promise<WorkspaceChunkSearchResponse | null> {
    if (this.isDegraded || !this.worker) {
      return null;
    }
    const id = this.nextId();
    try {
      const result = await this.postRpc(
        { type: 'search-workspace-chunks', id, workspacePath, query, limit },
        timeoutMs,
      );
      return (result as WorkspaceChunkSearchResponse | null) ?? null;
    } catch (error) {
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async getIndexStatus(workspacePath: string): Promise<CodeIndexStatusSnapshot | null> {
    if (this.isDegraded || !this.worker) {
      return null;
    }
    const id = this.nextId();
    try {
      const result = await this.postRpc({ type: 'get-index-status', id, workspacePath });
      return (result as CodeIndexStatusSnapshot | null) ?? null;
    } catch (error) {
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async cancelIndex(workspacePath: string): Promise<void> {
    if (this.isDegraded || !this.worker) {
      return;
    }
    const id = this.nextId();
    try {
      await this.postRpc({ type: 'cancel-index', id, workspacePath });
    } catch (error) {
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async rebuildIndex(workspacePath: string): Promise<WarmWorkspaceResult> {
    const degradedResult: WarmWorkspaceResult = {
      indexed: false,
      absPath: workspacePath,
      primaryLanguage: 'typescript',
    };
    if (this.isDegraded || !this.worker) {
      return degradedResult;
    }
    const id = this.nextId();
    try {
      const result = await this.postRpc(
        { type: 'rebuild-index', id, workspacePath },
        undefined,
        () => this.cancelIndexFireAndForget(workspacePath),
      );
      return (result as WarmWorkspaceResult | null) ?? degradedResult;
    } catch (error) {
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      return degradedResult;
    }
  }

  async runMaintenance(timeoutMs: number = DEFAULT_MAINTENANCE_TIMEOUT_MS): Promise<CodememMaintenanceSnapshot | null> {
    if (this.isDegraded || !this.worker) {
      return null;
    }
    const id = this.nextId();
    try {
      const result = await this.postRpc({ type: 'run-maintenance', id }, timeoutMs);
      return (result as CodememMaintenanceSnapshot | null) ?? null;
    } catch (error) {
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
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
        if (code !== 0 && !this.shuttingDown) {
          this.handleWorkerError(new Error(`Index worker exited with code ${code}`));
        }
      });
      this.worker = w;
    } catch (err) {
      this.markDegraded(err instanceof Error ? err.message : String(err));
    }
  }

  private handleMessage(msg: IndexWorkerOutboundMsg): void {
    if (msg.type === 'code-index-changed') {
      this.emit('code-index:changed', {
        workspacePath: msg.workspacePath,
        workspaceHash: msg.workspaceHash,
        paths: msg.paths,
        timestamp: msg.timestamp,
      } satisfies IndexWorkerCodeIndexChangedEvent);
      return;
    }

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
    if (this.shuttingDown) {
      return;
    }
    this.markDegraded(err.message);
    if (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.restartAttempts++;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.shuttingDown) {
          return;
        }
        this.isDegraded = false;
        this.startWorker();
      }, RESTART_BACKOFF_MS);
      this.restartTimer.unref?.();
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

  private cancelIndexFireAndForget(workspacePath: string): void {
    if (!this.worker) return;
    try {
      this.worker.postMessage({
        type: 'cancel-index',
        id: this.nextId(),
        workspacePath,
      } satisfies IndexWorkerInboundMsg & { id: number });
    } catch {
      // best-effort cancellation
    }
  }

  private postRpc(
    msg: IndexWorkerInboundMsg & { id: number },
    timeoutMs?: number,
    onTimeout?: () => void,
  ): Promise<unknown> {
    if (!this.worker) return Promise.resolve(null);
    const effectiveTimeout = timeoutMs ?? this.defaultRpcTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.id);
        this.metrics.dropped++;
        onTimeout?.();
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
