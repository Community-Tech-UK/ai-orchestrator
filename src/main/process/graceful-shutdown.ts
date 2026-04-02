// src/main/process/graceful-shutdown.ts
/**
 * Graceful Shutdown Manager
 *
 * Replaces the two-phase ad-hoc cleanup in src/main/index.ts with
 * an ordered, priority-based, per-phase-budget shutdown system.
 *
 * Phases run in ascending priority order. Within the same priority,
 * sync handlers run before async handlers. Each phase has an individual
 * time budget; a timed-out phase is skipped (status: 'timeout') and
 * execution continues with the next phase.
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
  error?: Error;
}

export interface ShutdownReport {
  phases: PhaseResult[];
  totalDurationMs: number;
  orphanDetected: boolean;
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
  async execute(): Promise<ShutdownReport> {
    const startTime = Date.now();
    const results: PhaseResult[] = [];

    if (this.orphanCheckInterval !== null) {
      clearInterval(this.orphanCheckInterval);
      this.orphanCheckInterval = null;
    }

    // Sort: ascending priority, then sync before async within same priority
    const sorted = [...this.phases].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // sync phases come first within same priority
      if (a.sync && !b.sync) return -1;
      if (!a.sync && b.sync) return 1;
      return 0;
    });

    for (const phase of sorted) {
      const budget = phase.budgetMs ?? DEFAULT_BUDGETS[phase.priority] ?? DEFAULT_BUDGET_FALLBACK;
      const phaseStart = Date.now();

      try {
        await Promise.race([
          Promise.resolve(phase.handler()),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Phase "${phase.name}" timed out after ${budget}ms`)), budget)
          ),
        ]);

        results.push({
          name: phase.name,
          priority: phase.priority,
          status: 'completed',
          durationMs: Date.now() - phaseStart,
        });
      } catch (err) {
        const durationMs = Date.now() - phaseStart;
        const isTimeout = err instanceof Error && err.message.includes('timed out after');

        if (isTimeout) {
          logger.warn(`Shutdown phase timed out`, { phase: phase.name, budgetMs: budget });
          results.push({
            name: phase.name,
            priority: phase.priority,
            status: 'timeout',
            durationMs,
          });
        } else {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error(`Shutdown phase failed`, error, { phase: phase.name });
          results.push({
            name: phase.name,
            priority: phase.priority,
            status: 'error',
            durationMs,
            error,
          });
        }
      }
    }

    return {
      phases: results,
      totalDurationMs: Date.now() - startTime,
      orphanDetected: process.platform !== 'win32' && process.ppid === 1,
    };
  }
}

export function getGracefulShutdownManager(): GracefulShutdownManager {
  return GracefulShutdownManager.getInstance();
}
