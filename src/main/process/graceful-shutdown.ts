// src/main/process/graceful-shutdown.ts
/**
 * Graceful Shutdown Manager
 *
 * Replaces the two-phase ad-hoc cleanup in src/main/index.ts with
 * an ordered, priority-based, per-phase-budget shutdown system.
 *
 * Phases run in ascending priority order. Within the same priority,
 * sync handlers run before async handlers. Each phase has an individual
 * time budget; when the timeout timer wins the cooperative race, execution
 * continues with the next phase.
 *
 * Backward compat: registerCleanupCompat() wraps existing cleanup
 * functions into the FINAL_CLEANUP phase so existing registerCleanup
 * call sites continue to work.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('GracefulShutdownManager');

// ── Priority constants ────────────────────────────────────────────────────────

export const ShutdownPriority = {
  SESSION_SYNC: 0,
  SIGNAL_CHILDREN: 10,
  FLUSH_IO: 20,
  STOP_BACKGROUND: 30,
  TERMINATE_INSTANCES: 40,
  FINAL_CLEANUP: 50,
} as const;

export type ShutdownPriorityValue = (typeof ShutdownPriority)[keyof typeof ShutdownPriority];

// ── Per-phase default budgets ─────────────────────────────────────────────────

const DEFAULT_BUDGETS: Record<number, number> = {
  [ShutdownPriority.SESSION_SYNC]: 2000,
  [ShutdownPriority.SIGNAL_CHILDREN]: 1000,
  [ShutdownPriority.FLUSH_IO]: 2000,
  [ShutdownPriority.STOP_BACKGROUND]: 1000,
  [ShutdownPriority.TERMINATE_INSTANCES]: 3000,
  [ShutdownPriority.FINAL_CLEANUP]: 1000,
};

const DEFAULT_BUDGET_FALLBACK = 2000;

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ShutdownPhase {
  name: string;
  priority: number;
  handler: () => void | Promise<void>;
  /** Per-phase time budget in ms. Defaults to priority-based table. */
  budgetMs?: number;
  /** If true, handler is synchronous — runs before async handlers at same priority. */
  sync?: boolean;
}

export interface PhaseResult {
  name: string;
  priority: number;
  status: 'completed' | 'timeout' | 'error';
  durationMs: number;
  errorKind?: ShutdownPhaseFailureKind;
}

export type ShutdownPhaseOutcome = 'started' | 'completed' | 'failed' | 'timed-out';
export type ShutdownPhaseFailureKind =
  | 'error'
  | 'type-error'
  | 'range-error'
  | 'aggregate-error'
  | 'non-error';

export interface ShutdownPhaseEvent {
  phase: string;
  priority: number;
  outcome: ShutdownPhaseOutcome;
  elapsedMs: number;
  budgetMs: number;
  timestamp: number;
}

export interface ShutdownReport {
  phases: PhaseResult[];
  events: ShutdownPhaseEvent[];
  totalDurationMs: number;
  orphanDetected: boolean;
}

export interface ShutdownPhaseAuditSummary {
  name: string;
  status: PhaseResult['status'];
  durationMs: number;
  errorKind?: ShutdownPhaseFailureKind;
}

export interface GracefulQuitFlowOptions {
  cleanupSync: () => void;
  cleanup: () => Promise<void>;
  preventDefault: () => void;
  quit: () => void;
  exit: (code: number) => void;
  timeoutMs: number;
  onTimeout?: () => void;
  onFailure?: (error: unknown) => void;
  onFinished?: () => void;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timeout: ReturnType<typeof setTimeout>) => void;
}

class ShutdownPhaseTimeoutError extends Error {
  constructor(
    readonly phaseName: string,
    readonly budgetMs: number,
  ) {
    super(`Shutdown phase timed out after ${budgetMs}ms`);
    this.name = 'ShutdownPhaseTimeoutError';
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

export class GracefulShutdownManager {
  private static instance: GracefulShutdownManager;
  private phases: ShutdownPhase[] = [];
  private orphanCallback: (() => void) | null = null;
  private orphanCheckInterval: ReturnType<typeof setInterval> | null = null;
  private signalHandlersRegistered = false;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  static getInstance(): GracefulShutdownManager {
    if (!this.instance) {
      this.instance = new GracefulShutdownManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      if (this.instance.orphanCheckInterval !== null) {
        clearInterval(this.instance.orphanCheckInterval);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.instance as any) = undefined;
  }

  /** Register a shutdown phase handler. */
  register(phase: ShutdownPhase): void {
    this.phases.push(phase);
  }

  /**
   * Backward compat bridge — wraps a legacy cleanup function into the
   * FINAL_CLEANUP priority so existing registerCleanup() call sites can
   * be migrated incrementally.
   */
  registerCleanupCompat(fn: () => void | Promise<void>): void {
    this.register({
      name: `compat:${this.phases.length}`,
      priority: ShutdownPriority.FINAL_CLEANUP,
      handler: fn,
    });
  }

  /**
   * Register a callback for orphan detection (ppid === 1).
   * Checked every 30 seconds on macOS/Linux only.
   */
  onOrphanDetected(cb: () => void): void {
    this.orphanCallback = cb;

    if (process.platform === 'win32') return;

    if (this.orphanCheckInterval !== null) {
      clearInterval(this.orphanCheckInterval);
    }

    this.orphanCheckInterval = setInterval(() => {
      try {
        if (process.ppid === 1) {
          logger.warn('Orphan process detected (ppid=1) — triggering shutdown');
          cb();
        }
      } catch {
        // Best effort
      }
    }, 30_000);
  }

  /**
   * Execute all registered phases in priority order.
   * Returns a ShutdownReport describing what happened.
   */
  async execute(oneShotPhases: ShutdownPhase[] = []): Promise<ShutdownReport> {
    const startTime = Date.now();
    const results: PhaseResult[] = [];
    const events: ShutdownPhaseEvent[] = [];

    if (this.orphanCheckInterval !== null) {
      clearInterval(this.orphanCheckInterval);
      this.orphanCheckInterval = null;
    }

    // Sort: ascending priority, then sync before async within same priority
    const sorted = [...this.phases, ...oneShotPhases].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // sync phases come first within same priority
      if (a.sync && !b.sync) return -1;
      if (!a.sync && b.sync) return 1;
      return 0;
    });

    for (const phase of sorted) {
      const budget = phase.budgetMs ?? DEFAULT_BUDGETS[phase.priority] ?? DEFAULT_BUDGET_FALLBACK;
      const phaseStart = Date.now();
      this.recordPhaseEvent(events, phase, 'started', 0, budget);

      try {
        await this.runPhaseWithBudget(phase, budget);

        const durationMs = Date.now() - phaseStart;
        this.recordPhaseEvent(events, phase, 'completed', durationMs, budget);
        results.push({
          name: phase.name,
          priority: phase.priority,
          status: 'completed',
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - phaseStart;
        const isTimeout = err instanceof ShutdownPhaseTimeoutError;

        if (isTimeout) {
          this.recordPhaseEvent(events, phase, 'timed-out', durationMs, budget);
          results.push({
            name: phase.name,
            priority: phase.priority,
            status: 'timeout',
            durationMs,
          });
        } else {
          const errorKind = classifyShutdownPhaseFailure(err);
          this.recordPhaseEvent(events, phase, 'failed', durationMs, budget, errorKind);
          results.push({
            name: phase.name,
            priority: phase.priority,
            status: 'error',
            durationMs,
            errorKind,
          });
        }
      }
    }

    return {
      phases: results,
      events,
      totalDurationMs: Date.now() - startTime,
      orphanDetected: process.platform !== 'win32' && process.ppid === 1,
    };
  }

  private async runPhaseWithBudget(phase: ShutdownPhase, budgetMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new ShutdownPhaseTimeoutError(phase.name, budgetMs)),
        budgetMs,
      );
    });

    try {
      // Cooperative budget only: Promise.race lets shutdown continue after the
      // timeout callback is delivered, but it cannot interrupt synchronous work
      // or make progress while the event loop is blocked.
      await Promise.race([
        Promise.resolve().then(() => phase.handler()),
        timeoutPromise,
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private recordPhaseEvent(
    events: ShutdownPhaseEvent[],
    phase: ShutdownPhase,
    outcome: ShutdownPhaseOutcome,
    elapsedMs: number,
    budgetMs: number,
    errorKind?: ShutdownPhaseFailureKind,
  ): void {
    const event: ShutdownPhaseEvent = {
      phase: phase.name,
      priority: phase.priority,
      outcome,
      elapsedMs,
      budgetMs,
      timestamp: Date.now(),
    };
    events.push(event);

    const logData: Record<string, unknown> = {
      phase: event.phase,
      priority: event.priority,
      outcome: event.outcome,
      elapsedMs: event.elapsedMs,
      budgetMs: event.budgetMs,
    };
    if (errorKind) {
      logData['errorKind'] = errorKind;
    }

    if (outcome === 'timed-out') {
      logger.warn('Shutdown phase budget elapsed; continuing cooperatively', logData);
    } else if (outcome === 'failed') {
      logger.error('Shutdown phase failed', undefined, logData);
    } else {
      logger.info('Shutdown phase event', logData);
    }
  }
}

function classifyShutdownPhaseFailure(error: unknown): ShutdownPhaseFailureKind {
  if (error instanceof AggregateError) return 'aggregate-error';
  if (error instanceof TypeError) return 'type-error';
  if (error instanceof RangeError) return 'range-error';
  if (error instanceof Error) return 'error';
  return 'non-error';
}

export function toShutdownPhaseAuditSummary(phase: PhaseResult): ShutdownPhaseAuditSummary {
  return {
    name: phase.name,
    status: phase.status,
    durationMs: phase.durationMs,
    errorKind: phase.errorKind,
  };
}

export function getGracefulShutdownManager(): GracefulShutdownManager {
  return GracefulShutdownManager.getInstance();
}

export function startGracefulQuitFlow(options: GracefulQuitFlowOptions): void {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  options.cleanupSync();
  options.preventDefault();

  const timeout = setTimeoutFn(() => {
    options.onTimeout?.();
    options.exit(0);
  }, options.timeoutMs);

  options.cleanup()
    .catch((error) => {
      options.onFailure?.(error);
    })
    .finally(() => {
      clearTimeoutFn(timeout);
      options.onFinished?.();
      options.quit();
    });
}
