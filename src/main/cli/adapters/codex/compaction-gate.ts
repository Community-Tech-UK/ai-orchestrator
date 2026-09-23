/**
 * Bounded await for Codex's asynchronous thread compaction to land.
 *
 * `thread/compact/start` only *starts* compaction — completion is signalled
 * separately (see `compaction-signals.ts`). A per-turn-input-cap retry or a
 * controlled recovery must wait for that signal so it runs against the
 * shrunken thread rather than racing the pre-compact one. The wait is
 * time-bounded in two phases: the provider must report the compaction as
 * running within the start window, after which it gets a longer running
 * window, because summarising a large thread routinely takes over a minute.
 *
 * - `timed-out`: nothing was reported inside the start window, which is
 *   evidence the provider build does not signal compaction at all.
 * - `stalled`: the compaction was reported running but did not finish inside
 *   the running window. The provider does signal compaction; it was just slow.
 */
export type CompactionGateOutcome = 'observed' | 'timed-out' | 'stalled' | 'cancelled';

interface GateWaiter {
  finish(outcome: CompactionGateOutcome): void;
  markRunning(): void;
}

export class CompactionGate {
  private readonly waiters = new Set<GateWaiter>();

  /**
   * Resolves when {@link settle} is next called, or when the active window
   * elapses — `timeoutMs` until {@link markRunning}, then `runningTimeoutMs`.
   */
  wait(timeoutMs: number, runningTimeoutMs = timeoutMs): Promise<CompactionGateOutcome> {
    return new Promise<CompactionGateOutcome>((resolve) => {
      let settled = false;
      let running = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms: number, outcome: CompactionGateOutcome): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => waiter.finish(outcome), ms);
        timer.unref?.();
      };
      const waiter: GateWaiter = {
        finish: (outcome) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(outcome);
        },
        markRunning: () => {
          if (settled || running) return;
          running = true;
          arm(runningTimeoutMs, 'stalled');
        },
      };
      this.waiters.add(waiter);
      arm(timeoutMs, 'timed-out');
    });
  }

  /** Releases every pending {@link wait}. Call when compaction is observed complete. */
  settle(): void {
    for (const waiter of [...this.waiters]) waiter.finish('observed');
  }

  /** Moves pending waits onto their running window. Idempotent per wait. */
  markRunning(): void {
    for (const waiter of [...this.waiters]) waiter.markRunning();
  }

  hasPendingWaiters(): boolean {
    return this.waiters.size > 0;
  }

  /** Releases pending waits when the compaction RPC could not be started. */
  cancel(): void {
    for (const waiter of [...this.waiters]) waiter.finish('cancelled');
  }
}
