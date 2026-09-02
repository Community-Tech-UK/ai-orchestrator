/**
 * ContextWorkerClient — main-process implementation of InstanceContextPort.
 *
 * Routes RLM and unified-memory work to a context worker so SQLite ingestion,
 * embedding, and context retrieval do not block Electron's main event loop.
 *
 * Contract:
 * - Fire-and-forget work is dropped when unavailable or overloaded.
 * - Context RPC timeouts resolve null so user input can continue.
 * - Worker crashes fail pending RPCs and trigger bounded restart backoff.
 * - Synchronous budget/format helpers remain in-process.
 */

import { isOccupancyPressureReading } from '../../shared/utils/context-occupancy';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { dispatchWorkerBroadcast } from './context-worker-event-relay';
import { createIsolatedWorkerProcess, type IsolatedWorkerProcess } from '../runtime/isolated-worker-process';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { RlmContextInfo, ContextBudget, UnifiedMemoryContextInfo } from './instance-types';
import type { InstanceContextPort } from './instance-context-port';
import {
  type RlmWorkerPort,
  type RlmWorkerRequest,
  type RlmWorkerResult,
} from './rlm-worker-port';
import {
  type UnifiedMemoryWorkerPort,
  type UnifiedMemoryWorkerRequest,
  type UnifiedMemoryWorkerResult,
} from './unified-memory-worker-port';
import { COMPACTION_KEEP_RECENT, trimBufferRetainingPrompts } from './prompt-retention';
import { ContextWorkerPrewarmLifecycle } from './context-worker-prewarm-lifecycle';
import { ContextWorkerRpcTracker, type RpcTimeoutMode } from './context-worker-rpc';
import {
  invokeRlmWorkerRpc,
  invokeUnifiedMemoryWorkerRpc,
} from './context-worker-owner-rpc';
import {
  buildMcpRuntimeToolContextSelection as selectMcpRuntimeToolContext,
  MCPToolSearchSnapshot,
  McpRuntimeToolContextSelection,
} from '../mcp/mcp-runtime-tool-context';
import type {
  HabitTrackerStateSnapshot,
  ContextWorkerInboundMsg,
  ContextWorkerRpcMsg,
  ContextWorkerOutboundMsg,
  ContextWorkerInstanceSnapshot,
  ContextWorkerOutputMsg,
  MetricsCollectorStateSnapshot,
  OutcomeTrackerStateSnapshot,
  ProjectMemoryBrief,
  ProjectMemoryBriefRequest,
  WorkerMetricsMsg,
} from './context-worker-protocol';

// ── Constants ──────────────────────────────────────────────────────────────────

const logger = getLogger('ContextWorkerClient');

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const RESTART_BACKOFF_MS = 2_000;
// Consecutive (not lifetime) crashes tolerated before the client stays degraded.
// `restartAttempts` is reset to 0 by handleMessage() whenever the worker answers
// an RPC, so a worker that crashes once, recovers, then crashes again much later
// in a long session still gets restarted rather than being permanently disabled.
const MAX_RESTART_ATTEMPTS = 3;
const MAX_INFLIGHT_INGESTION = 1_000;

// ── Budget calculation constants (mirrors InstanceContextManager defaults) ────

const CTX_BUDGET_MIN_TOKENS = 500;
const CTX_BUDGET_MAX_TOKENS = 4_000;
const RLM_MAX_TOKENS = 2_000;
const UNIFIED_MAX_TOKENS = 1_000;
const RLM_SECTION_MIN_TOKENS = 80;
const RLM_SECTION_MAX_COUNT = 10;

// ── Types ──────────────────────────────────────────────────────────────────────

type RpcMsgWithId = ContextWorkerRpcMsg;
export interface ContextWorkerClientOptions { rpcTimeoutMs?: number; workerFactory?: (userDataPath: string) => ContextWorkerProcessHandle; userDataPath?: string; }

export interface ContextWorkerMetrics {
  inFlight: number; processed: number; dropped: number;
  lastError: string | null; degraded: boolean;
  residency: WorkerMetricsMsg['residency'] | null;
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

type ContextWorkerProcessHandle = IsolatedWorkerProcess<ContextWorkerInboundMsg, ContextWorkerOutboundMsg>;

function makeWorker(userDataPath: string): ContextWorkerProcessHandle {
  const jsEntry = path.join(__dirname, 'context-worker-main.js');
  const entry = existsSync(jsEntry) ? jsEntry : path.join(__dirname, 'context-worker-main.ts');
  return createIsolatedWorkerProcess<ContextWorkerInboundMsg, ContextWorkerOutboundMsg>({
    name: 'context worker',
    entrypoint: entry,
    env: { AIO_USER_DATA_PATH: userDataPath },
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
  return sharedEstimateTokens(text);
}

// ── ContextWorkerClient ────────────────────────────────────────────────────────
export class ContextWorkerClient implements
  InstanceContextPort,
  RlmWorkerPort,
  UnifiedMemoryWorkerPort
{
  private worker: ContextWorkerProcessHandle | null = null;
  private rpcId = 0;
  private readonly rpcTracker = new ContextWorkerRpcTracker();
  private inflight = 0;
  private isDegraded = false;
  private restartAttempts = 0;
  private shuttingDown = false;
  private readonly prewarmLifecycle = new ContextWorkerPrewarmLifecycle(
    () => this.shuttingDown || this.isDegraded || !this.worker
      ? undefined
      : this.startHotPrewarm(),
  );
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly rpcTimeoutMs: number;
  private readonly workerFactory: (userDataPath: string) => ContextWorkerProcessHandle;
  private readonly userDataPath: string;
  private metrics = { processed: 0, dropped: 0, lastError: null as string | null };
  private residency: WorkerMetricsMsg['residency'] | null = null;

  constructor(options: ContextWorkerClientOptions = {}) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? makeWorker;
    this.userDataPath =
      options.userDataPath ?? getElectronUserDataPath() ?? '/tmp/ai-orchestrator';
    this.startWorker();
  }

  getMetrics(): ContextWorkerMetrics {
    return { inFlight: this.rpcTracker.size, processed: this.metrics.processed,
      dropped: this.metrics.dropped, lastError: this.metrics.lastError,
      degraded: this.isDegraded, residency: cloneResidency(this.residency) };
  }

  // ── Synchronous in-process methods ──────────────────────────────────────────

  calculateContextBudget(instance: Instance, message: string): ContextBudget {
    const usagePct = instance.contextUsage?.percentage ?? 0;
    const isChild = !!instance.parentId;

    // LT-034: must stay identical to `InstanceContext.calculateContextBudget`.
    // See `isOccupancyPressureReading` for why the raw percentage is not enough.
    const criticalThreshold = isChild ? 95 : 90;
    if (isOccupancyPressureReading(instance.contextUsage) && usagePct >= criticalThreshold) {
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
    const guidance =
      (context.skillCount ?? 0) > 0
        ? [
            'This context was added by the app, not typed by the user.',
            'Follow activated skill instructions when relevant.',
            'Treat memory notes as background.',
            'Do not mention this block unless directly asked about injected context.',
          ].join(' ')
        : [
            'This context was added by the app, not typed by the user.',
            'Treat it as non-authoritative background and do not mention this block',
            'unless directly asked about injected context.',
          ].join(' ');

    return [
      '[Orchestrator Memory Context]',
      'Source: Harness memory retrieval',
      guidance,
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

  recordTaskOutcome(taskId: string, success: boolean, score: number): void {
    if (!taskId || !Number.isFinite(score)) return void this.metrics.dropped++;
    this.postFireAndForget({ type: 'record-task-outcome', taskId, success, score });
  }

  endRlmSession(instanceId: string): void {
    this.postFireAndForget({ type: 'end-rlm-session', instanceId });
  }

  // ── RPC methods ──────────────────────────────────────────────────────────────
  async invokeRlm<TRequest extends RlmWorkerRequest>(request: TRequest): Promise<RlmWorkerResult<TRequest>> {
    return invokeRlmWorkerRpc(
      (message) => this.postRpc(message, 'reject'),
      this.nextId(), request, this.rpcTimeoutMs,
    );
  }

  async invokeUnifiedMemory<TRequest extends UnifiedMemoryWorkerRequest>(request: TRequest): Promise<UnifiedMemoryWorkerResult<TRequest>> {
    return invokeUnifiedMemoryWorkerRpc(
      (message) => this.postRpc(message, 'reject'),
      this.nextId(), request, this.rpcTimeoutMs,
    );
  }

  async initializeRlm(instance: Instance): Promise<void> {
    instance.rlmStoreSessionId = instance.sessionId;
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

  async buildWakeContextText(wing?: string): Promise<string | null> {
    if (this.isDegraded) return null;
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'build-wake-context-text',
      id,
      wing,
      bypassCache: true,
    });
    return typeof result === 'string' ? result : null;
  }

  async buildObservationContext(
    taskContext: string,
    instanceId?: string,
    taskType?: string,
  ): Promise<string | null> {
    if (this.isDegraded) {
      return null;
    }
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'build-observation-context',
      id,
      taskContext,
      instanceId,
      taskType,
    });
    return typeof result === 'string' ? result : null;
  }

  async buildProjectMemoryBrief(
    request: ProjectMemoryBriefRequest,
  ): Promise<ProjectMemoryBrief | null> {
    if (this.isDegraded) {
      return null;
    }
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'build-project-memory-brief',
      id,
      request,
    });
    return result ? (result as ProjectMemoryBrief) : null;
  }

  async buildMcpRuntimeToolContextSelection(
    snapshot: MCPToolSearchSnapshot,
    query?: string,
    maxTools?: number,
  ): Promise<McpRuntimeToolContextSelection | null> {
    if (this.isDegraded) {
      return selectMcpRuntimeToolContext(snapshot, { query, maxTools });
    }

    const id = this.nextId();
    try {
      const result = await this.postRpc({
        type: 'build-mcp-runtime-tool-context',
        id,
        snapshot,
        query,
        maxTools,
      });
      if (result) {
        return result as McpRuntimeToolContextSelection;
      }
      logger.warn('Context worker timed out for MCP tool selection; falling back to main thread');
      return selectMcpRuntimeToolContext(snapshot, { query, maxTools });
    } catch (error) {
      logger.warn('Context worker unavailable for MCP tool selection; falling back to main thread', {
        error: error instanceof Error ? error.message : String(error),
      });
      return selectMcpRuntimeToolContext(snapshot, { query, maxTools });
    }
  }

  async compactContext(instanceId: string, instance: Instance): Promise<void> {
    const id = this.nextId();
    await this.postRpc({
      type: 'compact-context',
      id,
      snapshot: snapshotFromInstance(instance),
    });
    // Trimming happens here, not in the worker, which cannot mutate the
    // Instance. Compaction persists nothing, so prompts are retained.
    trimBufferRetainingPrompts(instance, COMPACTION_KEEP_RECENT);
    void instanceId; // used implicitly through instance.id in snapshot
  }

  async reloadRlmPersistence(): Promise<void> {
    const id = this.nextId();
    await this.postRpc({ type: 'reload-rlm-persistence', id });
  }

  async startHotPrewarm(): Promise<boolean> {
    if (this.shuttingDown || this.isDegraded) return false;
    return await this.postRpc({ type: 'start-hot-prewarm', id: this.nextId() }) === true;
  }

  signalAppReady(): boolean {
    return this.prewarmLifecycle.signalAppReady();
  }

  cancelHotPrewarm(): void {
    this.postFireAndForget({ type: 'cancel-hot-prewarm' });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.cancelHotPrewarm();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    this.rpcTracker.rejectAll(new Error('shutdown'));
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
    if (this.shuttingDown || this.worker) return;
    try {
      const w = this.workerFactory(this.userDataPath);
      w.on('message', (msg: ContextWorkerOutboundMsg) => this.handleMessage(msg, w));
      w.on('error', (err) => this.handleWorkerError(err, w));
      w.on('exit', (code) => {
        if (code !== 0 && !this.shuttingDown) {
          this.handleWorkerError(new Error(`Context worker exited with code ${code}`), w);
        }
      });
      this.worker = w;
      this.residency = null;
      this.prewarmLifecycle.beginWorker();
      logger.info('Context worker started');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('Failed to start context worker; context retrieval disabled until restart', err instanceof Error ? err : undefined);
      this.markDegraded(reason);
    }
  }

  private handleMessage(msg: ContextWorkerOutboundMsg, sourceWorker: ContextWorkerProcessHandle): void {
    if (sourceWorker !== this.worker) return;
    // LT-169/170/206: dispatch process-local broadcasts in main. RLM events
    // publish to the manager-independent relay; skill/wake behavior is kept.
    if (msg.type === 'skill-activation' || msg.type === 'worker-event') return void dispatchWorkerBroadcast(msg);
    if (msg.type === 'worker-metrics') {
      this.residency = cloneResidency(msg.residency);
      return;
    }
    if (msg.type === 'ready') return this.prewarmLifecycle.markWorkerReady();
    if (msg.type !== 'rpc-response') return;
    if (!this.rpcTracker.settle(msg.id, msg.result, msg.error)) return;
    this.metrics.processed++;
    // A successful response proves the (possibly just-restarted) worker is
    // healthy, so clear the consecutive-crash counter. This makes the restart
    // cap count consecutive crashes rather than lifetime crashes.
    if (this.restartAttempts > 0) {
      this.restartAttempts = 0;
      logger.info('Context worker recovered after restart');
    }
  }

  private handleWorkerError(
    err: Error,
    failedWorker: ContextWorkerProcessHandle | null = this.worker,
  ): void {
    if (failedWorker && failedWorker !== this.worker) return;
    this.metrics.lastError = err.message;
    this.rpcTracker.rejectAll(err);
    this.cancelHotPrewarm();
    void failedWorker?.terminate().catch(() => undefined);
    this.worker = null;
    this.residency = null;
    if (this.shuttingDown) {
      return;
    }
    this.markDegraded(err.message);
    if (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.restartAttempts++;
      logger.warn('Context worker crashed; scheduling restart', {
        error: err.message,
        attempt: this.restartAttempts,
        maxAttempts: MAX_RESTART_ATTEMPTS,
        backoffMs: RESTART_BACKOFF_MS,
      });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.shuttingDown) {
          return;
        }
        this.isDegraded = false;
        this.startWorker();
      }, RESTART_BACKOFF_MS);
      this.restartTimer.unref?.();
    } else {
      logger.error('Context worker exceeded restart attempts; staying degraded (memory/RLM context disabled this session)', undefined, {
        error: err.message,
        maxAttempts: MAX_RESTART_ATTEMPTS,
      });
    }
  }

  async loadOutcomeTrackerState(maxExperiences: number): Promise<OutcomeTrackerStateSnapshot | null> {
    if (this.isDegraded) {
      return null;
    }
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'load-outcome-tracker-state',
      id,
      maxExperiences,
    });
    return (result as OutcomeTrackerStateSnapshot | null) ?? null;
  }

  async loadMetricsCollectorState(): Promise<MetricsCollectorStateSnapshot | null> {
    if (this.isDegraded) {
      return null;
    }
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'load-metrics-collector-state',
      id,
    });
    return (result as MetricsCollectorStateSnapshot | null) ?? null;
  }

  async loadHabitTrackerState(trackingWindowDays: number): Promise<HabitTrackerStateSnapshot | null> {
    if (this.isDegraded) {
      return null;
    }
    const id = this.nextId();
    const result = await this.postRpc({
      type: 'load-habit-tracker-state',
      id,
      trackingWindowDays,
    });
    return (result as HabitTrackerStateSnapshot | null) ?? null;
  }

  private markDegraded(reason: string): void {
    this.isDegraded = true;
    this.metrics.lastError = reason;
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

  private postRpc(
    msg: RpcMsgWithId,
    timeoutMode: RpcTimeoutMode = 'resolve-null',
  ): Promise<unknown> {
    return this.rpcTracker.post(
      this.worker,
      msg,
      this.rpcTimeoutMs,
      timeoutMode,
      () => this.metrics.dropped++,
    );
  }
}

function cloneResidency(residency: WorkerMetricsMsg['residency'] | null): WorkerMetricsMsg['residency'] | null {
  if (!residency) return null;
  return {
    ...residency,
    counts: { ...residency.counts },
    exhausted: { ...residency.exhausted },
    ...(residency.lastAdmissionFailure ? { lastAdmissionFailure: { reason: residency.lastAdmissionFailure.reason } } : {}),
  };
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
