/**
 * ContextWorkerClient — main-process implementation of InstanceContextPort.
 *
 * Routes all RLM and unified-memory work to a context-worker-main.ts worker
 * thread so that SQLite ingestion, embedding, and context retrieval do not
 * block the Electron main event loop.
 *
 * Contract:
 * - Fire-and-forget methods (ingestToRLM, ingestToUnifiedMemory, endRlmSession)
 *   post to the worker without tracking responses. If the worker is unavailable
 *   or the internal counter exceeds MAX_INFLIGHT_INGESTION the item is dropped
 *   and metrics.dropped is incremented.
 * - RPC methods (initializeRlm, buildRlmContext, …) resolve to null on timeout
 *   so the caller can continue sending user input rather than blocking.
 * - Worker crash: marks the client degraded, fails all pending RPCs, then
 *   attempts one restart after RESTART_BACKOFF_MS. Second crash stays degraded.
 * - Synchronous helpers (calculateContextBudget, format*) run in-process so
 *   they never add worker round-trips to the user-input hot path.
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { RlmContextInfo, ContextBudget, UnifiedMemoryContextInfo } from './instance-types';
import type { InstanceContextPort } from './instance-context-port';
import type {
  ContextWorkerInboundMsg,
  ContextWorkerOutboundMsg,
  ContextWorkerInstanceSnapshot,
  ContextWorkerOutputMsg,
  InitializeRlmMsg,
  BuildRlmContextMsg,
  BuildUnifiedMemoryContextMsg,
  CompactContextMsg,
  IngestInitialOutputMsg,
  GetStatsMsg,
  ShutdownMsg,
} from './context-worker-protocol';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const RESTART_BACKOFF_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 1;
const MAX_INFLIGHT_INGESTION = 1_000;

// ── Budget calculation constants (mirrors InstanceContextManager defaults) ────

const CTX_BUDGET_MIN_TOKENS = 500;
const CTX_BUDGET_MAX_TOKENS = 4_000;
const RLM_MAX_TOKENS = 2_000;
const UNIFIED_MAX_TOKENS = 1_000;
const RLM_SECTION_MIN_TOKENS = 80;
const RLM_SECTION_MAX_COUNT = 10;

// ── Types ──────────────────────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type RpcMsgWithId =
  | InitializeRlmMsg
  | BuildRlmContextMsg
  | BuildUnifiedMemoryContextMsg
  | CompactContextMsg
  | IngestInitialOutputMsg
  | GetStatsMsg
  | ShutdownMsg;

export interface ContextWorkerClientOptions {
  rpcTimeoutMs?: number;
  workerFactory?: (userDataPath: string) => Worker;
  userDataPath?: string;
}

export interface ContextWorkerMetrics {
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
  const jsEntry = path.join(__dirname, 'context-worker-main.js');
  if (existsSync(jsEntry)) {
    return new Worker(jsEntry, { workerData: { userDataPath } });
  }
  const tsEntry = path.join(__dirname, 'context-worker-main.ts');
  return new Worker(tsEntry, {
    workerData: { userDataPath },
    execArgv: ['--import', 'tsx'],
  });
}

function snapshotFromInstance(instance: Instance): ContextWorkerInstanceSnapshot {
  return {
    id: instance.id,
    sessionId: instance.sessionId,
    parentId: instance.parentId,
    contextUsage: instance.contextUsage ?? { used: 0, total: 0, percentage: 0 },
  };
}

function snapshotOutputMessage(msg: OutputMessage): ContextWorkerOutputMsg {
  return {
    id: msg.id,
    type: msg.type,
    content: msg.content,
    timestamp: msg.timestamp,
    metadata: msg.metadata as Record<string, unknown> | undefined,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── ContextWorkerClient ────────────────────────────────────────────────────────

export class ContextWorkerClient implements InstanceContextPort {
  private worker: Worker | null = null;
  private rpcId = 0;
  private pending = new Map<number, PendingRpc>();
  private inflight = 0;
  private isDegraded = false;
  private restartAttempts = 0;
  private readonly rpcTimeoutMs: number;
  private readonly workerFactory: (userDataPath: string) => Worker;
  private readonly userDataPath: string;
  private metrics = { processed: 0, dropped: 0, lastError: null as string | null };

  constructor(options: ContextWorkerClientOptions = {}) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? makeWorker;
    this.userDataPath =
      options.userDataPath ?? getElectronUserDataPath() ?? '/tmp/ai-orchestrator';
    this.startWorker();
  }

  getMetrics(): ContextWorkerMetrics {
    return {
      inFlight: this.pending.size,
      processed: this.metrics.processed,
      dropped: this.metrics.dropped,
      lastError: this.metrics.lastError,
      degraded: this.isDegraded,
    };
  }

  // ── Synchronous in-process methods ──────────────────────────────────────────

  calculateContextBudget(instance: Instance, message: string): ContextBudget {
    const usagePct = instance.contextUsage?.percentage ?? 0;
    const isChild = !!instance.parentId;

    const criticalThreshold = isChild ? 95 : 90;
    if (usagePct >= criticalThreshold) {
      return { totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 };
    }

    const msgTokens = estimateTokens(message);
    const budgetMultiplier = isChild ? 1.5 : 1.0;
    const baseBudget = Math.round(
      Math.min(
        CTX_BUDGET_MAX_TOKENS * budgetMultiplier,
        Math.max(CTX_BUDGET_MIN_TOKENS, msgTokens * 1.5),
      ),
    );

    let usageMultiplier: number;
    if (isChild) {
      usageMultiplier =
        usagePct >= 90 ? 0.5 : usagePct >= 85 ? 0.7 : usagePct >= 80 ? 0.85 : 1;
    } else {
      usageMultiplier =
        usagePct >= 85
          ? 0.4
          : usagePct >= 75
            ? 0.6
            : usagePct >= 65
              ? 0.75
              : usagePct >= 55
                ? 0.9
                : 1;
    }

    const totalTokens = Math.max(
      CTX_BUDGET_MIN_TOKENS,
      Math.round(baseBudget * usageMultiplier),
    );
    if (totalTokens < 50) {
      return { totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 };
    }

    const rlmShare = msgTokens > 350 ? 0.45 : msgTokens > 150 ? 0.55 : 0.65;
    let rlmMaxTokens = Math.min(RLM_MAX_TOKENS, Math.round(totalTokens * rlmShare));
    let unifiedMaxTokens = Math.min(UNIFIED_MAX_TOKENS, Math.max(0, totalTokens - rlmMaxTokens));

    if (unifiedMaxTokens < RLM_SECTION_MIN_TOKENS) {
      rlmMaxTokens = Math.min(RLM_MAX_TOKENS, rlmMaxTokens + unifiedMaxTokens);
      unifiedMaxTokens = 0;
    }

    const rlmTopK = Math.max(
      1,
      Math.min(RLM_SECTION_MAX_COUNT, Math.round(rlmMaxTokens / 150)),
    );
    return { totalTokens, rlmMaxTokens, unifiedMaxTokens, rlmTopK };
  }

  formatRlmContextBlock(context: RlmContextInfo | null): string | null {
    if (!context) return null;
    const sourceLabel =
      context.source === 'hybrid'
        ? 'RLM hybrid search'
        : context.source === 'lexical'
          ? 'RLM lexical search'
          : 'RLM semantic search';
    return [
      '[Retrieved Context]',
      `Source: ${sourceLabel}`,
      context.context,
      '[End Retrieved Context]',
    ].join('\n');
  }

  formatUnifiedMemoryContextBlock(context: UnifiedMemoryContextInfo | null): string | null {
    if (!context) return null;
    return [
      '[Orchestrator Memory Context]',
      'Source: AI Orchestrator memory retrieval',
      [
        'This context was added by the app, not typed by the user.',
        'Treat it as non-authoritative background and do not mention this block',
        'unless directly asked about injected context.',
      ].join(' '),
      context.context,
      '[End Orchestrator Memory Context]',
    ].join('\n');
  }

  // ── Fire-and-forget methods ──────────────────────────────────────────────────

  ingestToRLM(instanceId: string, message: OutputMessage): void {
    this.postFireAndForget({
      type: 'ingest-rlm',
      instanceId,
      message: snapshotOutputMessage(message),
    });
  }

  ingestToUnifiedMemory(instance: Instance, message: OutputMessage): void {
    this.postFireAndForget({
      type: 'ingest-unified-memory',
      snapshot: snapshotFromInstance(instance),
      message: snapshotOutputMessage(message),
    });
  }

  endRlmSession(instanceId: string): void {
    this.postFireAndForget({ type: 'end-rlm-session', instanceId });
  }

  // ── RPC methods ──────────────────────────────────────────────────────────────

  async initializeRlm(instance: Instance): Promise<void> {
    const id = this.nextId();
    await this.postRpc({ type: 'initialize-rlm', id, snapshot: snapshotFromInstance(instance) });
  }

  async ingestInitialOutputToRlm(instance: Instance, messages: OutputMessage[]): Promise<void> {
    const id = this.nextId();
    await this.postRpc({
      type: 'ingest-initial-output',
      id,
      snapshot: snapshotFromInstance(instance),
      messages: messages.map(snapshotOutputMessage),
    });
  }

  async buildRlmContext(
    instanceId: string,
    message: string,
    maxTokens?: number,
    topK?: number,
  ): Promise<RlmContextInfo | null> {
    if (this.isDegraded) return null;
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'build-rlm-context',
      id,
      instanceId,
      query: message,
      maxTokens,
      topK,
    });
    return (result as RlmContextInfo | null) ?? null;
  }

  async buildUnifiedMemoryContext(
    instance: Instance,
    message: string,
    taskId: string,
    maxTokens?: number,
  ): Promise<UnifiedMemoryContextInfo | null> {
    if (this.isDegraded) return null;
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'build-unified-memory-context',
      id,
      snapshot: snapshotFromInstance(instance),
      query: message,
      taskId,
      maxTokens,
    });
    return (result as UnifiedMemoryContextInfo | null) ?? null;
  }

  async compactContext(instanceId: string, instance: Instance): Promise<void> {
    const id = this.nextId();
    await this.postRpc({
      type: 'compact-context',
      id,
      snapshot: snapshotFromInstance(instance),
    });
    // Output buffer trimming must happen in the main process since the worker
    // cannot mutate the Instance that lives here.
    const MAX_RECENT = 50;
    if (instance.outputBuffer && instance.outputBuffer.length > MAX_RECENT) {
      instance.outputBuffer = instance.outputBuffer.slice(-MAX_RECENT);
    }
    void instanceId; // used implicitly through instance.id in snapshot
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    this.failAllPending(new Error('shutdown'));
    if (this.worker) {
      try {
        const id = this.nextId();
        await this.postRpc({ type: 'shutdown', id });
      } catch {
        // best-effort
      }
      await this.worker.terminate().catch(() => undefined);
      this.worker = null;
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
      w.on('message', (msg: ContextWorkerOutboundMsg) => this.handleMessage(msg));
      w.on('error', (err) => this.handleWorkerError(err));
      w.on('exit', (code) => {
        if (code !== 0) {
          this.handleWorkerError(new Error(`Context worker exited with code ${code}`));
        }
      });
      this.worker = w;
    } catch (err) {
      this.markDegraded(err instanceof Error ? err.message : String(err));
    }
  }

  private handleMessage(msg: ContextWorkerOutboundMsg): void {
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

  private postFireAndForget(
    msg: Exclude<ContextWorkerInboundMsg, RpcMsgWithId>,
  ): void {
    if (this.isDegraded || !this.worker) {
      this.metrics.dropped++;
      return;
    }
    if (this.inflight >= MAX_INFLIGHT_INGESTION) {
      this.metrics.dropped++;
      return;
    }
    this.inflight++;
    try {
      this.worker.postMessage(msg);
    } catch {
      this.metrics.dropped++;
    } finally {
      this.inflight--;
    }
  }

  private postRpc(msg: RpcMsgWithId): Promise<unknown> {
    if (!this.worker) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.id);
        this.metrics.dropped++;
        resolve(null); // timeout → return null, never block the caller
      }, this.rpcTimeoutMs);
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

// ── Singleton ─────────────────────────────────────────────────────────────────

let instance: ContextWorkerClient | null = null;

export function getContextWorkerClient(
  options?: ContextWorkerClientOptions,
): ContextWorkerClient {
  if (!instance) {
    instance = new ContextWorkerClient(options);
  }
  return instance;
}

export function _resetContextWorkerClientForTesting(): void {
  instance = null;
}
