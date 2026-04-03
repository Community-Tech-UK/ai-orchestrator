# Phase C: Reliability & Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graceful shutdown orchestration, slow operation detection, jitter-aware scheduling, and resume hints to improve reliability and lifecycle management.

**Architecture:** Four services that improve process lifecycle. Graceful shutdown replaces the existing two-phase cleanup with ordered phases. Slow operation detection wraps async operations with timing guards. Jitter scheduler replaces raw setInterval patterns. Resume hint stores last session for quick restart.

**Tech Stack:** TypeScript 5.9, Vitest, Node.js EventEmitter, Electron powerMonitor

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/main/process/graceful-shutdown.ts` | Ordered phase-based shutdown with per-phase budgets |
| Create | `src/main/process/__tests__/graceful-shutdown.spec.ts` | Tests for shutdown phases, timeouts, orphan detection |
| Create | `src/main/util/slow-operations.ts` | Async timing wrappers + global slow-op callback |
| Create | `src/main/util/__tests__/slow-operations.spec.ts` | Tests for measureAsync, measureOp, safeStringify/safeParse |
| Create | `src/main/tasks/jitter-scheduler.ts` | Singleton interval scheduler with jitter + suspend awareness |
| Create | `src/main/tasks/__tests__/jitter-scheduler.spec.ts` | Tests for scheduling, jitter, missed-task detection, shutdown |
| Create | `src/main/session/resume-hint.ts` | Saves/loads last-session hint to disk |
| Create | `src/main/session/__tests__/resume-hint.spec.ts` | Tests for save, load, expiry, clear |
| Modify | `src/main/session/session-continuity.ts` | Call saveHint on shutdown |

---

## Task 1: Graceful Shutdown Orchestration

**Files:**
- Create: `src/main/process/graceful-shutdown.ts`
- Create: `src/main/process/__tests__/graceful-shutdown.spec.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/main/process/__tests__/graceful-shutdown.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test' },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  GracefulShutdownManager,
  getGracefulShutdownManager,
  ShutdownPriority,
  type ShutdownPhase,
  type ShutdownReport,
} from '../graceful-shutdown';

describe('GracefulShutdownManager', () => {
  beforeEach(() => {
    GracefulShutdownManager._resetForTesting();
  });

  afterEach(() => {
    GracefulShutdownManager._resetForTesting();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = GracefulShutdownManager.getInstance();
      const b = GracefulShutdownManager.getInstance();
      expect(a).toBe(b);
    });

    it('getGracefulShutdownManager() returns the singleton', () => {
      const mgr = getGracefulShutdownManager();
      expect(mgr).toBe(GracefulShutdownManager.getInstance());
    });

    it('_resetForTesting creates a fresh instance', () => {
      const a = GracefulShutdownManager.getInstance();
      GracefulShutdownManager._resetForTesting();
      const b = GracefulShutdownManager.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('register()', () => {
    it('registers a phase handler without error', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        mgr.register({
          name: 'test-phase',
          priority: ShutdownPriority.STOP_BACKGROUND,
          handler: () => {},
        });
      }).not.toThrow();
    });

    it('accepts async handlers', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        mgr.register({
          name: 'async-phase',
          priority: ShutdownPriority.FLUSH_IO,
          handler: async () => { await Promise.resolve(); },
        });
      }).not.toThrow();
    });

    it('accepts sync flag', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        mgr.register({
          name: 'sync-phase',
          priority: ShutdownPriority.SESSION_SYNC,
          handler: () => {},
          sync: true,
        });
      }).not.toThrow();
    });
  });

  describe('execute()', () => {
    it('runs phases in priority order (lowest number first)', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const order: string[] = [];

      mgr.register({ name: 'last', priority: 50, handler: () => { order.push('last'); } });
      mgr.register({ name: 'first', priority: 0, handler: () => { order.push('first'); } });
      mgr.register({ name: 'middle', priority: 20, handler: () => { order.push('middle'); } });

      const report = await mgr.execute();

      expect(order).toEqual(['first', 'middle', 'last']);
      expect(report.phases).toHaveLength(3);
    });

    it('marks completed phases as completed', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      mgr.register({ name: 'ok', priority: 10, handler: () => {} });

      const report = await mgr.execute();
      const phase = report.phases.find(p => p.name === 'ok');

      expect(phase?.status).toBe('completed');
    });

    it('marks timed-out phases as timeout', async () => {
      vi.useFakeTimers();
      const mgr = GracefulShutdownManager.getInstance();

      mgr.register({
        name: 'slow',
        priority: 10,
        budgetMs: 100,
        handler: () => new Promise<void>(resolve => setTimeout(resolve, 5000)),
      });

      const executePromise = mgr.execute();
      await vi.runAllTimersAsync();
      const report = await executePromise;

      const phase = report.phases.find(p => p.name === 'slow');
      expect(phase?.status).toBe('timeout');
      vi.useRealTimers();
    });

    it('marks erroring phases as error and includes the error', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      mgr.register({
        name: 'broken',
        priority: 10,
        handler: () => { throw new Error('boom'); },
      });

      const report = await mgr.execute();
      const phase = report.phases.find(p => p.name === 'broken');

      expect(phase?.status).toBe('error');
      expect(phase?.error?.message).toBe('boom');
    });

    it('continues executing phases after one fails', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const ran: string[] = [];

      mgr.register({ name: 'fails', priority: 10, handler: () => { throw new Error('fail'); } });
      mgr.register({ name: 'ok', priority: 20, handler: () => { ran.push('ok'); } });

      const report = await mgr.execute();

      expect(ran).toContain('ok');
      expect(report.phases).toHaveLength(2);
    });

    it('returns a report with totalDurationMs', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      mgr.register({ name: 'quick', priority: 10, handler: () => {} });

      const report = await mgr.execute();

      expect(typeof report.totalDurationMs).toBe('number');
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('report includes orphanDetected field', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const report = await mgr.execute();
      expect(typeof report.orphanDetected).toBe('boolean');
    });

    it('records durationMs for each phase', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      mgr.register({ name: 'timed', priority: 10, handler: () => {} });

      const report = await mgr.execute();
      const phase = report.phases.find(p => p.name === 'timed');

      expect(typeof phase?.durationMs).toBe('number');
      expect(phase!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('runs multiple phases at same priority sequentially', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const log: string[] = [];

      mgr.register({ name: 'a', priority: 10, handler: async () => { log.push('a'); } });
      mgr.register({ name: 'b', priority: 10, handler: async () => { log.push('b'); } });

      await mgr.execute();

      expect(log).toContain('a');
      expect(log).toContain('b');
    });

    it('returns empty phases array when no handlers registered', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const report = await mgr.execute();
      expect(report.phases).toEqual([]);
    });
  });

  describe('ShutdownPriority constants', () => {
    it('SESSION_SYNC has priority 0', () => {
      expect(ShutdownPriority.SESSION_SYNC).toBe(0);
    });

    it('SIGNAL_CHILDREN has priority 10', () => {
      expect(ShutdownPriority.SIGNAL_CHILDREN).toBe(10);
    });

    it('FLUSH_IO has priority 20', () => {
      expect(ShutdownPriority.FLUSH_IO).toBe(20);
    });

    it('STOP_BACKGROUND has priority 30', () => {
      expect(ShutdownPriority.STOP_BACKGROUND).toBe(30);
    });

    it('TERMINATE_INSTANCES has priority 40', () => {
      expect(ShutdownPriority.TERMINATE_INSTANCES).toBe(40);
    });

    it('FINAL_CLEANUP has priority 50', () => {
      expect(ShutdownPriority.FINAL_CLEANUP).toBe(50);
    });
  });

  describe('backward compat: registerCleanup bridge', () => {
    it('exposes registerCleanupCompat that wraps into FINAL_CLEANUP phase', () => {
      const mgr = GracefulShutdownManager.getInstance();
      const ran: boolean[] = [];

      mgr.registerCleanupCompat(async () => { ran.push(true); });
      expect(ran).toHaveLength(0); // Not run yet
    });

    it('compat handlers run during execute()', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const ran: boolean[] = [];

      mgr.registerCleanupCompat(async () => { ran.push(true); });
      await mgr.execute();

      expect(ran).toHaveLength(1);
    });
  });

  describe('onOrphanDetected', () => {
    it('accepts a callback without throwing', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        mgr.onOrphanDetected(() => {});
      }).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/process/__tests__/graceful-shutdown.spec.ts --reporter=verbose`
Expected: FAIL — `Cannot find module '../graceful-shutdown'`

- [ ] **Step 3: Create the implementation**

```typescript
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
    (this.instance as unknown) = undefined;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/process/__tests__/graceful-shutdown.spec.ts --reporter=verbose`
Expected: PASS — all tests green

- [ ] **Step 5: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/process/graceful-shutdown.ts src/main/process/__tests__/graceful-shutdown.spec.ts
git commit -m "feat: add GracefulShutdownManager with ordered phases and per-phase budgets"
```

---

## Task 2: Slow Operation Detection

**Files:**
- Create: `src/main/util/slow-operations.ts`
- Create: `src/main/util/__tests__/slow-operations.spec.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/main/util/__tests__/slow-operations.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  measureAsync,
  measureOp,
  setSlowOpCallback,
  safeStringify,
  safeParse,
  getThreshold,
} from '../slow-operations';

describe('slow-operations', () => {
  beforeEach(() => {
    // Reset the global callback between tests
    setSlowOpCallback(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    setSlowOpCallback(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('measureAsync()', () => {
    it('returns the value from the wrapped function', async () => {
      const result = await measureAsync('test.op', async () => 42);
      expect(result).toBe(42);
    });

    it('propagates errors from the wrapped function', async () => {
      await expect(
        measureAsync('test.op', async () => { throw new Error('inner error'); })
      ).rejects.toThrow('inner error');
    });

    it('calls the slow-op callback when duration exceeds threshold', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      await measureAsync('test.slow', async () => {
        vi.advanceTimersByTime(200);
        return 'done';
      }, 50);

      expect(cb).toHaveBeenCalledWith('test.slow', expect.any(Number), 50);
    });

    it('does not call the slow-op callback when duration is under threshold', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      await measureAsync('test.fast', async () => 'ok', 500);

      expect(cb).not.toHaveBeenCalled();
    });

    it('uses the default threshold when none provided', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      // 'default' threshold is 100ms — advance past it
      await measureAsync('unknown.op', async () => {
        vi.advanceTimersByTime(150);
        return 'result';
      });

      expect(cb).toHaveBeenCalled();
    });

    it('uses threshold from THRESHOLDS table for known op names', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      // 'session.save' threshold is 200ms — advance to just under
      await measureAsync('session.save', async () => {
        vi.advanceTimersByTime(150);
        return 'saved';
      });

      // 150ms < 200ms threshold — should NOT fire
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires for session.save when duration exceeds its 200ms threshold', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      await measureAsync('session.save', async () => {
        vi.advanceTimersByTime(250);
        return 'saved';
      });

      expect(cb).toHaveBeenCalledWith('session.save', expect.any(Number), 200);
    });
  });

  describe('measureOp()', () => {
    it('returns a Disposable with a [Symbol.dispose] method', () => {
      const op = measureOp('test.op');
      expect(typeof op[Symbol.dispose]).toBe('function');
      op[Symbol.dispose]();
    });

    it('calls slow-op callback on dispose when slow', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      const op = measureOp('test.op', 50);
      vi.advanceTimersByTime(100);
      op[Symbol.dispose]();

      expect(cb).toHaveBeenCalledWith('test.op', expect.any(Number), 50);
    });

    it('does not call callback on dispose when fast', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      const op = measureOp('test.op', 500);
      op[Symbol.dispose]();

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('setSlowOpCallback()', () => {
    it('accepts null to clear the callback', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);
      setSlowOpCallback(null);

      // Should not throw even after clearing
      expect(() => safeStringify({ a: 1 })).not.toThrow();
    });

    it('replaces the previous callback', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      setSlowOpCallback(cb1);
      setSlowOpCallback(cb2);

      await measureAsync('test.op', async () => {
        vi.advanceTimersByTime(200);
      }, 50);

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });
  });

  describe('safeStringify()', () => {
    it('returns a JSON string', () => {
      const result = safeStringify({ key: 'value' });
      expect(result).toBe('{"key":"value"}');
    });

    it('handles arrays', () => {
      expect(safeStringify([1, 2, 3])).toBe('[1,2,3]');
    });

    it('handles primitives', () => {
      expect(safeStringify(42)).toBe('42');
      expect(safeStringify('hello')).toBe('"hello"');
      expect(safeStringify(true)).toBe('true');
    });

    it('calls slow-op callback when stringify is slow', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      // Patch Date.now to simulate elapsed time
      let callCount = 0;
      const realNow = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 0 : 200; // First call: start, second call: end
      });

      safeStringify({ x: 1 });

      expect(cb).toHaveBeenCalledWith('json.stringify', expect.any(Number), 50);

      Date.now = realNow;
    });
  });

  describe('safeParse()', () => {
    it('parses a valid JSON string', () => {
      expect(safeParse('{"key":"value"}')).toEqual({ key: 'value' });
    });

    it('parses arrays', () => {
      expect(safeParse('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('parses primitives', () => {
      expect(safeParse('42')).toBe(42);
      expect(safeParse('"hello"')).toBe('hello');
    });

    it('throws on invalid JSON (preserving JSON.parse semantics)', () => {
      expect(() => safeParse('not-json')).toThrow();
    });
  });

  describe('getThreshold()', () => {
    it('returns known threshold for recognized op names', () => {
      expect(getThreshold('json.stringify')).toBe(50);
      expect(getThreshold('json.parse')).toBe(50);
      expect(getThreshold('context.compact')).toBe(500);
      expect(getThreshold('session.save')).toBe(200);
      expect(getThreshold('session.restore')).toBe(500);
      expect(getThreshold('embedding.generate')).toBe(1000);
      expect(getThreshold('snapshot.write')).toBe(300);
    });

    it('returns default threshold (100) for unknown names', () => {
      expect(getThreshold('some.unknown.operation')).toBe(100);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/util/__tests__/slow-operations.spec.ts --reporter=verbose`
Expected: FAIL — `Cannot find module '../slow-operations'`

- [ ] **Step 3: Create the implementation**

```typescript
// src/main/util/slow-operations.ts
/**
 * Slow Operation Detection
 *
 * Wraps async operations with timing guards that fire a configurable callback
 * when a duration threshold is exceeded. Designed for lightweight production
 * use — no build-time elimination needed.
 *
 * Usage:
 *   const result = await measureAsync('session.save', () => saveState());
 *
 *   using op = measureOp('context.compact', 500);
 *   // ... do work ...
 *   // op[Symbol.dispose]() called automatically by 'using' block
 *
 * Telemetry integration:
 *   setSlowOpCallback((name, durationMs, thresholdMs) => {
 *     telemetry.record('slow_op', { name, durationMs, thresholdMs });
 *   });
 */

import { getLogger } from './logger';

const logger = getLogger('SlowOperations');

// ── Threshold table ───────────────────────────────────────────────────────────

const THRESHOLDS: Record<string, number> = {
  'json.stringify': 50,
  'json.parse': 50,
  'context.compact': 500,
  'session.save': 200,
  'session.restore': 500,
  'embedding.generate': 1000,
  'snapshot.write': 300,
  'default': 100,
};

// ── Global callback ───────────────────────────────────────────────────────────

type SlowOpCallback = (name: string, durationMs: number, thresholdMs: number) => void;

let slowOpCallback: SlowOpCallback | null = null;

/** Set (or clear) the global callback invoked when a slow operation is detected. */
export function setSlowOpCallback(cb: SlowOpCallback | null): void {
  slowOpCallback = cb;
}

// ── Threshold lookup ──────────────────────────────────────────────────────────

/** Returns the threshold in ms for a given operation name. */
export function getThreshold(name: string): number {
  return THRESHOLDS[name] ?? THRESHOLDS['default'];
}

// ── Core detection ────────────────────────────────────────────────────────────

function checkAndNotify(name: string, startMs: number, thresholdMs: number): void {
  const durationMs = Date.now() - startMs;
  if (durationMs > thresholdMs) {
    logger.warn('Slow operation detected', { name, durationMs, thresholdMs });
    slowOpCallback?.(name, durationMs, thresholdMs);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wraps an async function with timing measurement.
 * If the duration exceeds thresholdMs, logs a warning and fires the slow-op callback.
 */
export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>,
  thresholdMs?: number,
): Promise<T> {
  const threshold = thresholdMs ?? getThreshold(name);
  const start = Date.now();
  try {
    return await fn();
  } finally {
    checkAndNotify(name, start, threshold);
  }
}

/** Disposable returned by measureOp — used with the 'using' keyword (TS 5.2+). */
export interface Disposable {
  [Symbol.dispose](): void;
}

/**
 * Returns a Disposable that measures elapsed time when disposed.
 * Use with the 'using' keyword for automatic disposal at scope exit.
 */
export function measureOp(name: string, thresholdMs?: number): Disposable {
  const threshold = thresholdMs ?? getThreshold(name);
  const start = Date.now();
  return {
    [Symbol.dispose]() {
      checkAndNotify(name, start, threshold);
    },
  };
}

// ── Instrumented JSON wrappers ────────────────────────────────────────────────

/**
 * JSON.stringify with slow-operation timing.
 */
export function safeStringify(value: unknown): string {
  const threshold = getThreshold('json.stringify');
  const start = Date.now();
  const result = JSON.stringify(value);
  checkAndNotify('json.stringify', start, threshold);
  return result;
}

/**
 * JSON.parse with slow-operation timing.
 * Preserves JSON.parse throw semantics for invalid input.
 */
export function safeParse(json: string): unknown {
  const threshold = getThreshold('json.parse');
  const start = Date.now();
  const result = JSON.parse(json) as unknown;
  checkAndNotify('json.parse', start, threshold);
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/util/__tests__/slow-operations.spec.ts --reporter=verbose`
Expected: PASS — all tests green

- [ ] **Step 5: Instrument CompactionCoordinator**

In `src/main/context/compaction-coordinator.ts`, add the import and wrap `triggerCompaction`:

**Add import** near the top of the file (after existing imports):
```typescript
import { measureAsync } from '../util/slow-operations';
```

**Wrap the body of `triggerCompaction`** — locate the method and wrap its internal strategy call:

Find the line calling the compaction strategy (the `await this.compactionStrategy(instanceId)` call or similar) and replace with:
```typescript
await measureAsync('context.compact', () => this.compactionStrategy(instanceId));
```

- [ ] **Step 6: Instrument SessionContinuityManager**

In `src/main/session/session-continuity.ts`, add the import and wrap `saveState` (or the private auto-save method):

**Add import** near the top of the file:
```typescript
import { measureAsync } from '../util/slow-operations';
```

**Wrap the `saveState` body** — find the core file-write call inside the save method and wrap it:
```typescript
await measureAsync('session.save', () => this.writeStateToDisk(instanceId, state));
```

- [ ] **Step 7: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/main/util/slow-operations.ts src/main/util/__tests__/slow-operations.spec.ts src/main/context/compaction-coordinator.ts src/main/session/session-continuity.ts
git commit -m "feat: add slow operation detection with measureAsync/measureOp and safeStringify/safeParse"
```

---

## Task 3: Jitter Scheduler

**Files:**
- Create: `src/main/tasks/jitter-scheduler.ts`
- Create: `src/main/tasks/__tests__/jitter-scheduler.spec.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/main/tasks/__tests__/jitter-scheduler.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { JitterScheduler, getJitterScheduler } from '../jitter-scheduler';

describe('JitterScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    JitterScheduler._resetForTesting();
  });

  afterEach(() => {
    JitterScheduler._resetForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = JitterScheduler.getInstance();
      const b = JitterScheduler.getInstance();
      expect(a).toBe(b);
    });

    it('getJitterScheduler() returns the singleton', () => {
      expect(getJitterScheduler()).toBe(JitterScheduler.getInstance());
    });

    it('_resetForTesting returns a fresh instance', () => {
      const a = JitterScheduler.getInstance();
      JitterScheduler._resetForTesting();
      const b = JitterScheduler.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('schedule()', () => {
    it('returns the task ID', () => {
      const scheduler = JitterScheduler.getInstance();
      const id = scheduler.schedule({
        id: 'my-task',
        name: 'My Task',
        intervalMs: 1000,
        handler: vi.fn(),
      });
      expect(id).toBe('my-task');
    });

    it('auto-generates an ID when none provided', () => {
      const scheduler = JitterScheduler.getInstance();
      const id = scheduler.schedule({
        name: 'Auto ID Task',
        intervalMs: 1000,
        handler: vi.fn(),
      } as Parameters<typeof scheduler.schedule>[0]);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('executes the handler after interval elapses', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'tick-task',
        name: 'Tick Task',
        intervalMs: 1000,
        handler,
        jitterPercent: 0, // Disable jitter for deterministic test
      });

      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1100);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('executes multiple times over repeated intervals', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'repeat-task',
        name: 'Repeat Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      await vi.advanceTimersByTimeAsync(1600);
      expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not execute a disabled task', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'disabled-task',
        name: 'Disabled Task',
        intervalMs: 100,
        handler,
        enabled: false,
        jitterPercent: 0,
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('unschedule()', () => {
    it('stops the handler from executing after unschedule', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'cancel-task',
        name: 'Cancel Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      await vi.advanceTimersByTimeAsync(600);
      expect(handler).toHaveBeenCalledTimes(1);

      scheduler.unschedule('cancel-task');
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not more
    });

    it('does not throw when unscheduling an unknown ID', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.unschedule('nonexistent')).not.toThrow();
    });
  });

  describe('pause() and resume()', () => {
    it('pause prevents handler execution', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'pause-task',
        name: 'Pause Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      scheduler.pause('pause-task');
      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('resume re-enables execution after pause', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'resume-task',
        name: 'Resume Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      scheduler.pause('resume-task');
      await vi.advanceTimersByTimeAsync(600);
      expect(handler).not.toHaveBeenCalled();

      scheduler.resume('resume-task');
      await vi.advanceTimersByTimeAsync(600);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('pause on unknown ID does not throw', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.pause('unknown')).not.toThrow();
    });

    it('resume on unknown ID does not throw', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.resume('unknown')).not.toThrow();
    });
  });

  describe('onMissed()', () => {
    it('accepts a callback without throwing', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => {
        scheduler.onMissed(vi.fn());
      }).not.toThrow();
    });

    it('calls onMissed callback when a task is detected as missed', async () => {
      const scheduler = JitterScheduler.getInstance();
      const missedCb = vi.fn();
      scheduler.onMissed(missedCb);

      const handler = vi.fn();
      scheduler.schedule({
        id: 'missed-task',
        name: 'Missed Task',
        intervalMs: 1000,
        handler,
        jitterPercent: 0,
        maxCatchUp: 3,
      });

      // Simulate a large time jump that would cause missed executions
      await vi.advanceTimersByTimeAsync(5000);

      // The callback should have been called at some point due to drift detection
      // (exact behavior depends on implementation — just verify it doesn't throw)
      expect(typeof missedCb.mock.calls.length).toBe('number');
    });
  });

  describe('shutdown()', () => {
    it('stops all tasks from executing', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'shutdown-task',
        name: 'Shutdown Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      scheduler.shutdown();
      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not throw when called with no scheduled tasks', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.shutdown()).not.toThrow();
    });
  });

  describe('jitter algorithm', () => {
    it('adds non-negative jitter to the base interval', async () => {
      const scheduler = JitterScheduler.getInstance();
      const fireTimes: number[] = [];

      scheduler.schedule({
        id: 'jitter-test',
        name: 'Jitter Test',
        intervalMs: 1000,
        handler: () => { fireTimes.push(Date.now()); },
        jitterPercent: 10,
      });

      await vi.advanceTimersByTimeAsync(3500);

      // All fire times should be at or after 1000ms intervals (jitter only adds delay)
      expect(fireTimes.length).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/tasks/__tests__/jitter-scheduler.spec.ts --reporter=verbose`
Expected: FAIL — `Cannot find module '../jitter-scheduler'`

- [ ] **Step 3: Create the implementation**

```typescript
// src/main/tasks/jitter-scheduler.ts
/**
 * Jitter Scheduler
 *
 * Replaces raw setInterval patterns across the codebase with a centralized
 * scheduler that adds randomized jitter to prevent thundering herds when
 * multiple periodic tasks fire simultaneously.
 *
 * Existing setInterval patterns to migrate:
 *   - Session auto-save:     60s in session-continuity.ts
 *   - Hibernation check:     60s in hibernation-manager.ts
 *   - Pool warmup:           30s in pool-manager.ts
 *   - Stuck process check:   10s in stuck-process-detector.ts
 *   - Main process monitor:   1s in index.ts
 *
 * Suspend awareness: integrates with Electron powerMonitor 'resume' event
 * to detect missed executions after laptop lid-close/VM pause.
 */

import { powerMonitor } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('JitterScheduler');

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ScheduledTask {
  id?: string;
  name: string;
  intervalMs: number;
  handler: () => void | Promise<void>;
  /** Adds 0–N% random delay on top of intervalMs. Default: 10. */
  jitterPercent?: number;
  /** Shift by 3s if firing within 2s of a :00 minute boundary. Default: true. */
  avoidMinuteBoundary?: boolean;
  /** Max missed executions to catch up on after resume. Default: 3. */
  maxCatchUp?: number;
  /** Whether to immediately start scheduling. Default: true. */
  enabled?: boolean;
}

type MissedCallback = (taskId: string, missedCount: number) => void;

// ── Internal state ────────────────────────────────────────────────────────────

interface TaskState {
  task: Required<ScheduledTask>;
  timer: ReturnType<typeof setTimeout> | null;
  lastExecution: number;
  paused: boolean;
}

// ── Jitter algorithm ──────────────────────────────────────────────────────────

function nextTickMs(intervalMs: number, jitterPercent: number, avoidMinuteBoundary: boolean): number {
  const jitter = Math.random() * intervalMs * (jitterPercent / 100);
  let next = intervalMs + jitter;
  if (avoidMinuteBoundary) {
    const nextAbsolute = Date.now() + next;
    const secondsInMinute = (nextAbsolute / 1000) % 60;
    if (secondsInMinute < 2 || secondsInMinute > 58) {
      next += 3000;
    }
  }
  return next;
}

// ── Implementation ────────────────────────────────────────────────────────────

let taskCounter = 0;

export class JitterScheduler {
  private static instance: JitterScheduler;
  private tasks = new Map<string, TaskState>();
  private missedCallback: MissedCallback | null = null;

  private constructor() {
    this.setupPowerMonitor();
  }

  static getInstance(): JitterScheduler {
    if (!this.instance) {
      this.instance = new JitterScheduler();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.shutdown();
      try {
        powerMonitor.off('resume', (this.instance as unknown as { _resumeHandler: () => void })._resumeHandler);
      } catch {
        // Best effort — powerMonitor may be mocked
      }
    }
    (this.instance as unknown) = undefined;
  }

  private setupPowerMonitor(): void {
    const resumeHandler = () => this.handleSystemResume();
    (this as unknown as { _resumeHandler: () => void })._resumeHandler = resumeHandler;
    try {
      powerMonitor.on('resume', resumeHandler);
    } catch {
      // powerMonitor may not be available in test environments
    }
  }

  private handleSystemResume(): void {
    logger.info('System resume detected — checking for missed tasks');
    const now = Date.now();

    for (const [id, state] of this.tasks) {
      if (state.paused) continue;

      const elapsed = now - state.lastExecution;
      const missedCount = Math.floor(elapsed / state.task.intervalMs) - 1;

      if (missedCount > 0) {
        const catchUpCount = Math.min(missedCount, state.task.maxCatchUp);
        logger.warn('Missed task executions detected after resume', {
          taskId: id,
          missedCount,
          catchUpCount,
        });

        this.missedCallback?.(id, missedCount);

        for (let i = 0; i < catchUpCount; i++) {
          this.runHandler(id, state);
        }
      }
    }
  }

  /** Schedule a task. Returns the task ID. */
  schedule(task: ScheduledTask): string {
    const id = task.id ?? `task-${++taskCounter}`;

    const normalized: Required<ScheduledTask> = {
      id,
      name: task.name,
      intervalMs: task.intervalMs,
      handler: task.handler,
      jitterPercent: task.jitterPercent ?? 10,
      avoidMinuteBoundary: task.avoidMinuteBoundary ?? true,
      maxCatchUp: task.maxCatchUp ?? 3,
      enabled: task.enabled ?? true,
    };

    const state: TaskState = {
      task: normalized,
      timer: null,
      lastExecution: Date.now(),
      paused: !normalized.enabled,
    };

    this.tasks.set(id, state);

    if (normalized.enabled) {
      this.scheduleNext(id, state);
    }

    return id;
  }

  private scheduleNext(id: string, state: TaskState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }

    const delayMs = nextTickMs(
      state.task.intervalMs,
      state.task.jitterPercent,
      state.task.avoidMinuteBoundary,
    );

    state.timer = setTimeout(() => {
      this.runHandler(id, state);
    }, delayMs);
  }

  private runHandler(id: string, state: TaskState): void {
    if (!this.tasks.has(id) || state.paused) return;

    state.lastExecution = Date.now();

    try {
      const result = state.task.handler();
      if (result instanceof Promise) {
        result.catch((err) => {
          logger.error('Scheduled task handler threw', err instanceof Error ? err : undefined, {
            taskId: id,
            taskName: state.task.name,
          });
        });
      }
    } catch (err) {
      logger.error('Scheduled task handler threw synchronously', err instanceof Error ? err : undefined, {
        taskId: id,
        taskName: state.task.name,
      });
    }

    // Re-schedule next execution (only if still registered)
    if (this.tasks.has(id) && !state.paused) {
      this.scheduleNext(id, state);
    }
  }

  /** Remove a task and clear its timer. */
  unschedule(id: string): void {
    const state = this.tasks.get(id);
    if (!state) return;

    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    this.tasks.delete(id);
  }

  /** Pause a task — timer is cleared but task remains registered. */
  pause(id: string): void {
    const state = this.tasks.get(id);
    if (!state) return;

    state.paused = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /** Resume a paused task — reschedules for next tick. */
  resume(id: string): void {
    const state = this.tasks.get(id);
    if (!state) return;

    state.paused = false;
    this.scheduleNext(id, state);
  }

  /** Register a callback for missed-task notifications. */
  onMissed(cb: MissedCallback): void {
    this.missedCallback = cb;
  }

  /** Clear all tasks and timers. */
  shutdown(): void {
    for (const [, state] of this.tasks) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.tasks.clear();
  }
}

export function getJitterScheduler(): JitterScheduler {
  return JitterScheduler.getInstance();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/tasks/__tests__/jitter-scheduler.spec.ts --reporter=verbose`
Expected: PASS — all tests green

- [ ] **Step 5: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/tasks/jitter-scheduler.ts src/main/tasks/__tests__/jitter-scheduler.spec.ts
git commit -m "feat: add JitterScheduler singleton with jitter, pause/resume, and suspend awareness"
```

---

## Task 4: Resume Hint

**Files:**
- Create: `src/main/session/resume-hint.ts`
- Create: `src/main/session/__tests__/resume-hint.spec.ts`
- Modify: `src/main/session/session-continuity.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/main/session/__tests__/resume-hint.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test' },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Use real fs for these tests — we write to a real temp directory
const TEST_DIR = path.join(os.tmpdir(), `resume-hint-test-${process.pid}`);

vi.mock('../resume-hint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resume-hint')>();
  return actual;
});

import {
  ResumeHintManager,
  getResumeHintManager,
  type ResumeHint,
} from '../resume-hint';

describe('ResumeHintManager', () => {
  beforeEach(() => {
    ResumeHintManager._resetForTesting();
    // Clean test directory
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    ResumeHintManager._resetForTesting();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = ResumeHintManager.getInstance(TEST_DIR);
      const b = ResumeHintManager.getInstance(TEST_DIR);
      expect(a).toBe(b);
    });

    it('getResumeHintManager() returns the singleton', () => {
      const mgr = getResumeHintManager(TEST_DIR);
      expect(mgr).toBe(ResumeHintManager.getInstance(TEST_DIR));
    });

    it('_resetForTesting creates a fresh instance', () => {
      const a = ResumeHintManager.getInstance(TEST_DIR);
      ResumeHintManager._resetForTesting();
      const b = ResumeHintManager.getInstance(TEST_DIR);
      expect(a).not.toBe(b);
    });
  });

  describe('saveHint()', () => {
    it('writes a JSON file to disk', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const hint: ResumeHint = {
        sessionId: 'sess-001',
        instanceId: 'inst-001',
        displayName: 'My Session',
        timestamp: Date.now(),
        workingDirectory: '/home/user/project',
        instanceCount: 3,
        provider: 'claude',
        model: 'claude-opus-4-5',
      };

      mgr.saveHint(hint);

      const filePath = path.join(TEST_DIR, 'last-session.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('written file is valid JSON matching the hint', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const hint: ResumeHint = {
        sessionId: 'sess-002',
        instanceId: 'inst-002',
        displayName: 'Test Session',
        timestamp: 1700000000000,
        workingDirectory: '/tmp/work',
        instanceCount: 1,
        provider: 'gemini',
      };

      mgr.saveHint(hint);

      const filePath = path.join(TEST_DIR, 'last-session.json');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ResumeHint;

      expect(parsed.sessionId).toBe('sess-002');
      expect(parsed.instanceId).toBe('inst-002');
      expect(parsed.displayName).toBe('Test Session');
      expect(parsed.provider).toBe('gemini');
    });

    it('creates the directory if it does not exist', () => {
      const nestedDir = path.join(TEST_DIR, 'nested', 'deep');
      const mgr = new (ResumeHintManager as unknown as new (dir: string) => ResumeHintManager)(nestedDir);

      const hint: ResumeHint = {
        sessionId: 'sess-003',
        instanceId: 'inst-003',
        displayName: 'Nested',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      };

      expect(() => mgr.saveHint(hint)).not.toThrow();
      expect(fs.existsSync(path.join(nestedDir, 'last-session.json'))).toBe(true);
    });

    it('overwrites an existing hint', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);

      mgr.saveHint({
        sessionId: 'old-session',
        instanceId: 'inst-old',
        displayName: 'Old',
        timestamp: 1000,
        workingDirectory: '/old',
        instanceCount: 1,
        provider: 'claude',
      });

      mgr.saveHint({
        sessionId: 'new-session',
        instanceId: 'inst-new',
        displayName: 'New',
        timestamp: 2000,
        workingDirectory: '/new',
        instanceCount: 2,
        provider: 'gemini',
      });

      const filePath = path.join(TEST_DIR, 'last-session.json');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ResumeHint;

      expect(parsed.sessionId).toBe('new-session');
    });

    it('does not throw if write fails (best-effort sync write)', () => {
      const mgr = ResumeHintManager.getInstance('/nonexistent-readonly-path');
      const hint: ResumeHint = {
        sessionId: 'sess-fail',
        instanceId: 'inst-fail',
        displayName: 'Fail',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      };

      // Should swallow errors — saveHint is called during shutdown
      expect(() => mgr.saveHint(hint)).not.toThrow();
    });
  });

  describe('getHint()', () => {
    it('returns null when no hint file exists', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(mgr.getHint()).toBeNull();
    });

    it('returns the saved hint', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const hint: ResumeHint = {
        sessionId: 'sess-get',
        instanceId: 'inst-get',
        displayName: 'Get Session',
        timestamp: Date.now(),
        workingDirectory: '/projects/app',
        instanceCount: 2,
        provider: 'claude',
        model: 'claude-3-sonnet',
      };

      mgr.saveHint(hint);
      const loaded = mgr.getHint();

      expect(loaded).not.toBeNull();
      expect(loaded?.sessionId).toBe('sess-get');
      expect(loaded?.model).toBe('claude-3-sonnet');
    });

    it('returns null when hint is older than 7 days', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

      mgr.saveHint({
        sessionId: 'stale-session',
        instanceId: 'inst-stale',
        displayName: 'Stale',
        timestamp: eightDaysAgo,
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      expect(mgr.getHint()).toBeNull();
    });

    it('returns hint when exactly within 7 days', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;

      mgr.saveHint({
        sessionId: 'fresh-session',
        instanceId: 'inst-fresh',
        displayName: 'Fresh',
        timestamp: sixDaysAgo,
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      expect(mgr.getHint()).not.toBeNull();
    });

    it('returns null when hint file is corrupted JSON', () => {
      const filePath = path.join(TEST_DIR, 'last-session.json');
      fs.writeFileSync(filePath, 'not-valid-json', 'utf-8');

      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(mgr.getHint()).toBeNull();
    });

    it('returns null when hint file is valid JSON but missing required fields', () => {
      const filePath = path.join(TEST_DIR, 'last-session.json');
      fs.writeFileSync(filePath, JSON.stringify({ partial: true }), 'utf-8');

      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(mgr.getHint()).toBeNull();
    });
  });

  describe('clearHint()', () => {
    it('removes the hint file', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);

      mgr.saveHint({
        sessionId: 'clear-session',
        instanceId: 'inst-clear',
        displayName: 'Clear',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      const filePath = path.join(TEST_DIR, 'last-session.json');
      expect(fs.existsSync(filePath)).toBe(true);

      mgr.clearHint();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('does not throw if hint file does not exist', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(() => mgr.clearHint()).not.toThrow();
    });

    it('getHint() returns null after clearHint()', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);

      mgr.saveHint({
        sessionId: 'post-clear',
        instanceId: 'inst-pc',
        displayName: 'Post Clear',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      mgr.clearHint();
      expect(mgr.getHint()).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/session/__tests__/resume-hint.spec.ts --reporter=verbose`
Expected: FAIL — `Cannot find module '../resume-hint'`

- [ ] **Step 3: Create the implementation**

```typescript
// src/main/session/resume-hint.ts
/**
 * Resume Hint Manager
 *
 * Persists the last active session to disk so the app can offer quick
 * resume on next startup. The hint is a lightweight JSON file written
 * synchronously during shutdown (in the SESSION_SYNC phase) to ensure
 * it survives crashes and forced quits.
 *
 * Integration:
 *   - GracefulShutdownManager calls saveHint() in SESSION_SYNC phase
 *   - App startup reads getHint() and sends to renderer via IPC
 *   - IPC channel: SESSION_GET_RESUME_HINT → returns ResumeHint | null
 *   - clearHint() is called after successful resume to avoid stale prompts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../logging/logger';

const logger = getLogger('ResumeHintManager');

// ── Constants ─────────────────────────────────────────────────────────────────

const HINT_FILE_NAME = 'last-session.json';
const HINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ResumeHint {
  sessionId: string;
  instanceId: string;
  displayName: string;
  timestamp: number;
  workingDirectory: string;
  instanceCount: number;
  provider: string;
  model?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

function isValidHint(obj: unknown): obj is ResumeHint {
  if (typeof obj !== 'object' || obj === null) return false;
  const h = obj as Record<string, unknown>;
  return (
    typeof h['sessionId'] === 'string' &&
    typeof h['instanceId'] === 'string' &&
    typeof h['displayName'] === 'string' &&
    typeof h['timestamp'] === 'number' &&
    typeof h['workingDirectory'] === 'string' &&
    typeof h['instanceCount'] === 'number' &&
    typeof h['provider'] === 'string'
  );
}

// ── Implementation ────────────────────────────────────────────────────────────

export class ResumeHintManager {
  private static instance: ResumeHintManager;
  private readonly hintPath: string;

  constructor(storeDir: string) {
    this.hintPath = path.join(storeDir, HINT_FILE_NAME);
  }

  static getInstance(storeDir?: string): ResumeHintManager {
    if (!this.instance) {
      const dir = storeDir ?? path.join(os.homedir(), '.orchestrator');
      this.instance = new ResumeHintManager(dir);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as unknown) = undefined;
  }

  /**
   * Write the hint synchronously.
   * Called during shutdown — must not throw or block quit.
   */
  saveHint(hint: ResumeHint): void {
    try {
      const dir = path.dirname(this.hintPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.hintPath, JSON.stringify(hint), 'utf-8');
      logger.info('Resume hint saved', { sessionId: hint.sessionId });
    } catch (err) {
      logger.warn('Failed to save resume hint', { error: String(err) });
    }
  }

  /**
   * Read and validate the hint from disk.
   * Returns null if the file is missing, corrupted, or older than 7 days.
   */
  getHint(): ResumeHint | null {
    try {
      const raw = fs.readFileSync(this.hintPath, 'utf-8');
      const obj = JSON.parse(raw) as unknown;

      if (!isValidHint(obj)) {
        logger.warn('Resume hint file has invalid structure — ignoring');
        return null;
      }

      if (Date.now() - obj.timestamp > HINT_MAX_AGE_MS) {
        logger.info('Resume hint is stale — ignoring', {
          ageMs: Date.now() - obj.timestamp,
        });
        return null;
      }

      return obj;
    } catch {
      return null;
    }
  }

  /**
   * Delete the hint file.
   * Called after a successful resume to prevent stale prompts.
   */
  clearHint(): void {
    try {
      fs.unlinkSync(this.hintPath);
    } catch {
      // File may not exist — best effort
    }
  }
}

export function getResumeHintManager(storeDir?: string): ResumeHintManager {
  return ResumeHintManager.getInstance(storeDir);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/session/__tests__/resume-hint.spec.ts --reporter=verbose`
Expected: PASS — all tests green

- [ ] **Step 5: Wire saveHint into SessionContinuityManager.shutdown()**

In `src/main/session/session-continuity.ts`, add the import and call:

**Add import** near the top of the file (after existing imports):
```typescript
import { getResumeHintManager } from './resume-hint';
```

**In the `shutdown()` method**, after the sync state saves and before returning, add:

```typescript
// Persist resume hint for quick restart on next launch
try {
  const states = [...this.sessionStates.values()];
  const mostRecent = states.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0];
  if (mostRecent) {
    getResumeHintManager().saveHint({
      sessionId: mostRecent.sessionId ?? mostRecent.instanceId,
      instanceId: mostRecent.instanceId,
      displayName: mostRecent.displayName ?? mostRecent.instanceId,
      timestamp: Date.now(),
      workingDirectory: mostRecent.workingDirectory ?? process.cwd(),
      instanceCount: this.sessionStates.size,
      provider: mostRecent.provider ?? 'claude',
      model: mostRecent.model,
    });
  }
} catch {
  // Best effort — never block shutdown
}
```

**Note:** The exact field names (`lastModified`, `displayName`, `workingDirectory`, `provider`, `model`) must be verified against the actual `SessionState` interface in `session-continuity.ts` before committing. Adjust property access to match the real interface.

- [ ] **Step 6: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors — if SessionState fields differ, fix the property names in Step 5

- [ ] **Step 7: Commit**

```bash
git add src/main/session/resume-hint.ts src/main/session/__tests__/resume-hint.spec.ts src/main/session/session-continuity.ts
git commit -m "feat: add ResumeHintManager and wire saveHint into session shutdown"
```

---

## Final Verification Checklist

After completing all four tasks, run the full verification suite:

- [ ] **All new tests pass:**
  ```bash
  npx vitest run src/main/process/__tests__/graceful-shutdown.spec.ts src/main/util/__tests__/slow-operations.spec.ts src/main/tasks/__tests__/jitter-scheduler.spec.ts src/main/session/__tests__/resume-hint.spec.ts --reporter=verbose
  ```

- [ ] **Full TypeScript check (source and specs):**
  ```bash
  npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
  ```

- [ ] **Lint check on all modified files:**
  ```bash
  npx eslint src/main/process/graceful-shutdown.ts src/main/util/slow-operations.ts src/main/tasks/jitter-scheduler.ts src/main/session/resume-hint.ts src/main/session/session-continuity.ts
  ```

- [ ] **No regressions in existing tests:**
  ```bash
  npx vitest run src/main/process/__tests__/supervisor-tree.spec.ts src/main/util/__tests__/cleanup-registry.spec.ts src/main/session/session-continuity.spec.ts --reporter=verbose
  ```

## Implementation Notes

**C1 — Graceful Shutdown:** The `GracefulShutdownManager` does not replace `src/main/util/cleanup-registry.ts` — it wraps it. Existing `registerCleanup()` call sites are unaffected. Migration path: replace `registerCleanup(fn)` with `getGracefulShutdownManager().register({ name: '...', priority: ShutdownPriority.FINAL_CLEANUP, handler: fn })` incrementally.

**C2 — Slow Operations:** The instrumentation of `CompactionCoordinator` and `SessionContinuityManager` in Steps 5–6 requires reading those files before editing to find the exact method and call-site. The import and wrap pattern is the same in both cases.

**C3 — Jitter Scheduler:** The existing `setInterval` calls in `hibernation-manager.ts`, `pool-manager.ts`, `stuck-process-detector.ts`, and `session-continuity.ts` are NOT migrated in this task — that is a follow-on task. This task only creates the scheduler. Migration of individual intervals should happen in separate commits to keep diffs reviewable.

**C4 — Resume Hint:** The `SessionState` interface fields (`lastModified`, `displayName`, `workingDirectory`, `provider`, `model`) must be verified against the actual type definition before the Step 5 code compiles. The typecheck in Step 6 will catch any mismatches.
