/**
 * A generic keyed coalescing worker: accepts values per key and calls the
 * worker function with only the *latest* value for each key. Rapid updates
 * on the same key are coalesced — the worker is never called with stale data.
 *
 * Inspired by t3code's `packages/shared/src/KeyedCoalescingWorker.ts`.
 *
 * Usage
 * -----
 * ```ts
 * const worker = new KeyedCoalescingWorker(
 *   async (key, value) => { ... },
 *   { debounceMs: 50 }
 * );
 *
 * worker.push('repo-a', statusA); // schedules work
 * worker.push('repo-a', statusA2); // replaces pending work for repo-a
 * await worker.drain('repo-a');   // waits until repo-a has no queued work
 * await worker.drainAll();        // waits until all keys are idle
 * ```
 */
export type CoalescingWorkerFn<TKey extends string, TValue> = (
  key: TKey,
  value: TValue,
) => Promise<void>;

export interface KeyedCoalescingWorkerOptions {
  /** Milliseconds to wait before executing after the last push (default: 0). */
  debounceMs?: number;
}

interface PendingEntry<TValue> {
  value: TValue;
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves when the current in-flight run finishes. */
  running: Promise<void> | null;
  /** Resolve callbacks for drain() callers waiting on this key. */
  drainWaiters: (() => void)[];
}

export class KeyedCoalescingWorker<TKey extends string = string, TValue = unknown> {
  private readonly pending = new Map<TKey, PendingEntry<TValue>>();
  private readonly debounceMs: number;

  constructor(
    private readonly fn: CoalescingWorkerFn<TKey, TValue>,
    options: KeyedCoalescingWorkerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 0;
  }

  /**
   * Queue `value` for `key`. If a value is already pending for the same key
   * the old value is replaced (latest-wins). If debounceMs > 0, the timer is
   * reset so the debounce window extends from the most recent push.
   */
  push(key: TKey, value: TValue): void {
    let entry = this.pending.get(key);

    if (!entry) {
      entry = { value, timer: null, running: null, drainWaiters: [] };
      this.pending.set(key, entry);
    } else {
      // Latest value wins; cancel existing debounce timer.
      entry.value = value;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }

    if (this.debounceMs > 0) {
      entry.timer = setTimeout(() => this.flush(key), this.debounceMs);
    } else {
      void this.flush(key);
    }
  }

  /**
   * Flush any pending value for `key` immediately, bypassing the debounce
   * window. No-op if there is no pending value or a run is already in flight.
   */
  flushNow(key: TKey): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    void this.flush(key);
  }

  /**
   * Resolve when there is no pending or in-flight work for `key`.
   * If nothing is queued returns immediately.
   */
  drain(key: TKey): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return Promise.resolve();

    return new Promise<void>((resolve) => {
      entry.drainWaiters.push(resolve);
    });
  }

  /**
   * Resolve when there is no pending or in-flight work for any key.
   */
  drainAll(): Promise<void> {
    const drains = Array.from(this.pending.keys()).map((k) => this.drain(k));
    return Promise.all(drains).then(() => undefined);
  }

  /** Number of keys that currently have pending or in-flight work. */
  get activeKeyCount(): number {
    return this.pending.size;
  }

  private async flush(key: TKey): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;

    // Wait for any currently in-flight run to finish before starting a new one.
    if (entry.running !== null) {
      await entry.running;
      // After the previous run finished there may be a new pending value —
      // the next scheduled flush will handle it.
      return;
    }

    // Capture the current latest value and clear the pending slot so any
    // push() that arrives while we run goes into a fresh pending entry.
    const value = entry.value;
    const waiters = entry.drainWaiters.splice(0);
    this.pending.delete(key);

    const run = this.fn(key, value)
      .catch(() => {
        // Worker errors are intentionally swallowed here; callers that need
        // error propagation should handle it inside the worker function.
      })
      .finally(() => {
        // Resolve drain() callers that were waiting on this key.
        for (const resolve of waiters) resolve();

        // If new work arrived for this key while we were running, the entry
        // will be present again — leave it for the next flush cycle.
        const fresh = this.pending.get(key);
        if (fresh) {
          fresh.running = null;
        }
      });

    // Re-create the entry to track the in-flight run so drain() callers that
    // arrive *during* the run can still wait correctly.
    const inFlight: PendingEntry<TValue> = {
      value,
      timer: null,
      running: run,
      drainWaiters: waiters, // already spliced above; passed for completeness
    };
    this.pending.set(key, inFlight);

    await run;

    // Clean up the entry if no new work has been pushed.
    const afterRun = this.pending.get(key);
    if (afterRun === inFlight) {
      this.pending.delete(key);
    }
  }
}
