/**
 * LT-652: one pending send-backoff timer per instance.
 *
 * Without this coalescing, every `processMessageQueue` call during a hold
 * (the 2 s watchdog plus each ready-status edge) allocates its own timer and
 * they all fire together — N concurrent drains and N `queuePromote` IPC calls
 * for one message. Split out of `instance-messaging.store.ts` for the LOC ratchet.
 */
export class QueueRetryTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Replace any pending timer for this instance with one that fires `onFire`. */
  schedule(instanceId: string, delayMs: number, onFire: () => void): void {
    this.cancel(instanceId);
    this.timers.set(instanceId, setTimeout(() => {
      this.timers.delete(instanceId);
      onFire();
    }, delayMs));
  }

  cancel(instanceId: string): void {
    const pending = this.timers.get(instanceId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.timers.delete(instanceId);
    }
  }
}
