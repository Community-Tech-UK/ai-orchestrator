/**
 * Bounded await for Codex's asynchronous thread compaction to land.
 *
 * `thread/compact/start` only *starts* compaction — completion is signalled
 * separately by a `thread/compacted` notification. A per-turn-input-cap retry
 * must wait for that signal so it runs against the shrunken thread rather than
 * racing the pre-compact one. The wait is time-bounded: a Codex build that
 * never emits the notification for an explicit compaction degrades to "retry
 * anyway" instead of hanging forever.
 */
export class CompactionGate {
  private readonly waiters = new Set<() => void>();

  /**
   * Resolves when {@link settle} is next called, or after `timeoutMs` —
   * whichever comes first.
   */
  wait(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.waiters.add(finish);
    });
  }

  /** Releases every pending {@link wait}. Call on a `thread/compacted` signal. */
  settle(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
