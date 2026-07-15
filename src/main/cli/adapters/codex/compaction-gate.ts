/**
 * Bounded await for Codex's asynchronous thread compaction to land.
 *
 * `thread/compact/start` only *starts* compaction — completion is signalled
 * separately by a `thread/compacted` notification. A per-turn-input-cap retry
 * must wait for that signal so it runs against the shrunken thread rather than
 * racing the pre-compact one. The wait is time-bounded: a Codex build that
 * never emits the notification for an explicit compaction returns a distinct
 * timeout outcome so callers can fail closed instead of racing a retry.
 */
export type CompactionGateOutcome = 'observed' | 'timed-out' | 'cancelled';

export class CompactionGate {
  private readonly waiters = new Set<(outcome: CompactionGateOutcome) => void>();

  /**
   * Resolves when {@link settle} is next called, or after `timeoutMs` —
   * whichever comes first.
   */
  wait(timeoutMs: number): Promise<CompactionGateOutcome> {
    return new Promise<CompactionGateOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CompactionGateOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish('timed-out'), timeoutMs);
      timer.unref?.();
      this.waiters.add(finish);
    });
  }

  /** Releases every pending {@link wait}. Call on a `thread/compacted` signal. */
  settle(): void {
    for (const waiter of [...this.waiters]) waiter('observed');
  }

  hasPendingWaiters(): boolean {
    return this.waiters.size > 0;
  }

  /** Releases pending waits when the compaction RPC could not be started. */
  cancel(): void {
    for (const waiter of [...this.waiters]) waiter('cancelled');
  }
}
