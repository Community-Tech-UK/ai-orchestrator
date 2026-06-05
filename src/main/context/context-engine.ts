/**
 * ContextEngine (B3) — one boundary for per-turn conversation-context handling.
 *
 * Today the context/compaction logic is driven directly through
 * `CompactionCoordinator` (auto-compaction) + `ContextCompactor` (strategy
 * chain). This interface puts a single seam in front of that so the per-turn
 * consumer (`instance-event-forwarding`) talks to ONE abstraction, and so an
 * alternative engine can be swapped in later without touching call sites.
 *
 * `LegacyContextEngine` is the default implementation — a thin façade that
 * delegates to the existing, battle-tested coordinator (no behavioural change).
 * `SafeContextEngine` wraps the active engine with quarantine/fallback so a
 * faulty engine cannot wedge the hot per-turn path: if `onContextUpdate` throws,
 * the engine is quarantined (auto-compaction degrades off) rather than breaking
 * batch-update forwarding for every instance.
 */

import type { ContextUsage, Instance, InstanceStatus, OutputMessage } from '../../shared/types/instance.types';
import type { IndexedCodebaseContextInfo } from '../indexing/indexed-codebase-context';
import type { InstanceContextPort } from '../instance/instance-context-port';
import type { ContextBudget, RlmContextInfo, UnifiedMemoryContextInfo } from '../instance/instance-types';
import { getLogger } from '../logging/logger';
import {
  getCompactionCoordinator,
  type CompactionCoordinator,
  type CompactionResult,
} from './compaction-coordinator';

const logger = getLogger('ContextEngine');

/** Snapshot of an instance's context state for status surfaces. */
export interface ContextStatus {
  /** Most recent usage seen by the engine, or null if none yet. */
  latestUsage: ContextUsage | null;
  /** Whether a compaction is currently running for the instance. */
  isCompacting: boolean;
  /** Most recent settled status reported after a turn, or null if none yet. */
  lastTurnStatus: InstanceStatus | null;
}

export interface ContextIngestRequest {
  instance: Instance;
  message: OutputMessage;
  contextPort: InstanceContextPort;
}

export interface ContextAssembleRequest {
  instance: Instance;
  message: string;
  contextPort: InstanceContextPort;
  taskId?: string;
  buildIndexedCodebaseContext?: (
    instance: Instance,
    message: string,
  ) => Promise<IndexedCodebaseContextInfo | null>;
}

export interface ContextAssemblyResult {
  budget: ContextBudget;
  rlmContext: RlmContextInfo | null;
  unifiedMemoryContext: UnifiedMemoryContextInfo | null;
  indexedCodebaseContext: IndexedCodebaseContextInfo | null;
}

export interface ContextAfterTurnRequest {
  instance: Instance;
  status: InstanceStatus;
}

/**
 * The per-turn context boundary. Implementations own how conversation context
 * is monitored and compacted as a turn's token usage grows.
 */
export interface ContextEngine {
  /** Called on every contextUsage update (per batch-update). Drives auto-compaction. */
  onContextUpdate(instanceId: string, usage: ContextUsage): void;
  /** Ingest an output message into the active context stores. */
  ingest(request: ContextIngestRequest): void;
  /** Assemble retrieved context for a user input turn. */
  assemble(request: ContextAssembleRequest): Promise<ContextAssemblyResult>;
  /** Called when an instance turn settles. */
  afterTurn(request: ContextAfterTurnRequest): void;
  /** Explicit user/IPC-driven compaction. */
  compactInstance(instanceId: string): Promise<CompactionResult>;
  /** Current context status for the instance. */
  getStatus(instanceId: string): ContextStatus;
  /** Release per-instance state (on terminate/restart). */
  cleanupInstance(instanceId: string): void;
}

/**
 * Default engine: delegates to the existing `CompactionCoordinator`. Tracks the
 * last usage it forwarded so `getStatus` can report it without reaching into the
 * coordinator's private state.
 */
export class LegacyContextEngine implements ContextEngine {
  private readonly coordinator: CompactionCoordinator;
  private readonly latestUsage = new Map<string, ContextUsage>();
  private readonly lastTurnStatus = new Map<string, InstanceStatus>();

  constructor(coordinator: CompactionCoordinator = getCompactionCoordinator()) {
    this.coordinator = coordinator;
  }

  onContextUpdate(instanceId: string, usage: ContextUsage): void {
    this.latestUsage.set(instanceId, usage);
    this.coordinator.onContextUpdate(instanceId, usage);
  }

  ingest({ instance, message, contextPort }: ContextIngestRequest): void {
    contextPort.ingestToRLM(instance.id, message);
    contextPort.ingestToUnifiedMemory(instance, message);
  }

  async assemble({
    instance,
    message,
    contextPort,
    taskId = `context-${Date.now()}`,
    buildIndexedCodebaseContext,
  }: ContextAssembleRequest): Promise<ContextAssemblyResult> {
    const budget = contextPort.calculateContextBudget(instance, message);
    const [rlmContext, unifiedMemoryContext, indexedCodebaseContext] = await Promise.all([
      contextPort.buildRlmContext(instance.id, message, budget.rlmMaxTokens, budget.rlmTopK),
      contextPort.buildUnifiedMemoryContext(instance, message, taskId, budget.unifiedMaxTokens),
      buildIndexedCodebaseContext ? buildIndexedCodebaseContext(instance, message) : Promise.resolve(null),
    ]);

    return {
      budget,
      rlmContext,
      unifiedMemoryContext,
      indexedCodebaseContext,
    };
  }

  afterTurn({ instance, status }: ContextAfterTurnRequest): void {
    this.lastTurnStatus.set(instance.id, status);
    if (instance.contextUsage) {
      this.onContextUpdate(instance.id, instance.contextUsage);
    }
  }

  compactInstance(instanceId: string): Promise<CompactionResult> {
    return this.coordinator.compactInstance(instanceId);
  }

  getStatus(instanceId: string): ContextStatus {
    return {
      latestUsage: this.latestUsage.get(instanceId) ?? null,
      isCompacting: this.coordinator.isCompacting(instanceId),
      lastTurnStatus: this.lastTurnStatus.get(instanceId) ?? null,
    };
  }

  cleanupInstance(instanceId: string): void {
    this.latestUsage.delete(instanceId);
    this.lastTurnStatus.delete(instanceId);
    this.coordinator.cleanupInstance(instanceId);
  }
}

/**
 * Quarantine/fallback wrapper. Guards the hot per-turn path: an engine that
 * throws from `onContextUpdate` is quarantined (subsequent calls become no-ops)
 * so it degrades to "no auto-compaction" instead of breaking batch-update
 * forwarding for all instances. Async/manual paths surface errors to their
 * callers as normal.
 */
export class SafeContextEngine implements ContextEngine {
  private quarantined = false;

  constructor(private readonly inner: ContextEngine) {}

  /** Test/diagnostic visibility into whether the engine has been quarantined. */
  isQuarantined(): boolean {
    return this.quarantined;
  }

  onContextUpdate(instanceId: string, usage: ContextUsage): void {
    if (this.quarantined) return;
    try {
      this.inner.onContextUpdate(instanceId, usage);
    } catch (err) {
      this.quarantined = true;
      logger.error(
        'ContextEngine.onContextUpdate failed — quarantining (auto-compaction disabled this session)',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  ingest(request: ContextIngestRequest): void {
    if (this.quarantined) return;
    try {
      this.inner.ingest(request);
    } catch (err) {
      this.quarantined = true;
      logger.error(
        'ContextEngine.ingest failed — quarantining context ingestion/assembly this session',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async assemble(request: ContextAssembleRequest): Promise<ContextAssemblyResult> {
    if (this.quarantined) {
      return this.emptyAssembly(this.fallbackBudget(request));
    }
    try {
      return await this.inner.assemble(request);
    } catch (err) {
      this.quarantined = true;
      logger.error(
        'ContextEngine.assemble failed — quarantining context ingestion/assembly this session',
        err instanceof Error ? err : new Error(String(err)),
      );
      return this.emptyAssembly(this.fallbackBudget(request));
    }
  }

  afterTurn(request: ContextAfterTurnRequest): void {
    if (this.quarantined) return;
    try {
      this.inner.afterTurn(request);
    } catch (err) {
      this.quarantined = true;
      logger.error(
        'ContextEngine.afterTurn failed — quarantining context engine this session',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  compactInstance(instanceId: string): Promise<CompactionResult> {
    // Manual compaction is IPC-driven; let errors propagate to the caller.
    return this.inner.compactInstance(instanceId);
  }

  getStatus(instanceId: string): ContextStatus {
    try {
      return this.inner.getStatus(instanceId);
    } catch {
      return { latestUsage: null, isCompacting: false, lastTurnStatus: null };
    }
  }

  cleanupInstance(instanceId: string): void {
    try {
      this.inner.cleanupInstance(instanceId);
    } catch (err) {
      logger.warn('ContextEngine.cleanupInstance failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emptyAssembly(budget: ContextBudget): ContextAssemblyResult {
    return {
      budget,
      rlmContext: null,
      unifiedMemoryContext: null,
      indexedCodebaseContext: null,
    };
  }

  private fallbackBudget(request: ContextAssembleRequest): ContextBudget {
    try {
      return request.contextPort.calculateContextBudget(request.instance, request.message);
    } catch (err) {
      logger.warn('ContextEngine fallback budget calculation failed; using zero budget', {
        instanceId: request.instance.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 };
    }
  }
}

// ============================================================
// Module-level singleton (pluggable)
// ============================================================

let innerEngine: ContextEngine | null = null;
let safeEngine: SafeContextEngine | null = null;

/** The active per-turn context engine (safe-wrapped). */
export function getContextEngine(): ContextEngine {
  if (!safeEngine) {
    innerEngine = innerEngine ?? new LegacyContextEngine();
    safeEngine = new SafeContextEngine(innerEngine);
  }
  return safeEngine;
}

/** Install an alternative engine (e.g. an experiment). Wrapped for safety. */
export function setContextEngine(engine: ContextEngine): void {
  innerEngine = engine;
  safeEngine = new SafeContextEngine(engine);
}

export function _resetContextEngineForTesting(): void {
  innerEngine = null;
  safeEngine = null;
}
