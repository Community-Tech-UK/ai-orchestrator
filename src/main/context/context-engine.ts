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

import type { ContextUsage } from '../../shared/types/instance.types';
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
}

/**
 * The per-turn context boundary. Implementations own how conversation context
 * is monitored and compacted as a turn's token usage grows.
 */
export interface ContextEngine {
  /** Called on every contextUsage update (per batch-update). Drives auto-compaction. */
  onContextUpdate(instanceId: string, usage: ContextUsage): void;
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

  constructor(coordinator: CompactionCoordinator = getCompactionCoordinator()) {
    this.coordinator = coordinator;
  }

  onContextUpdate(instanceId: string, usage: ContextUsage): void {
    this.latestUsage.set(instanceId, usage);
    this.coordinator.onContextUpdate(instanceId, usage);
  }

  compactInstance(instanceId: string): Promise<CompactionResult> {
    return this.coordinator.compactInstance(instanceId);
  }

  getStatus(instanceId: string): ContextStatus {
    return {
      latestUsage: this.latestUsage.get(instanceId) ?? null,
      isCompacting: this.coordinator.isCompacting(instanceId),
    };
  }

  cleanupInstance(instanceId: string): void {
    this.latestUsage.delete(instanceId);
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

  compactInstance(instanceId: string): Promise<CompactionResult> {
    // Manual compaction is IPC-driven; let errors propagate to the caller.
    return this.inner.compactInstance(instanceId);
  }

  getStatus(instanceId: string): ContextStatus {
    try {
      return this.inner.getStatus(instanceId);
    } catch {
      return { latestUsage: null, isCompacting: false };
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
