/** Retain ownership after a failed stop; a rejected or hung lifecycle call is never a stop receipt. */
export class AutomationStopAttempts {
  private readonly pending = new Map<string, { stop: () => Promise<unknown>; attempts: number; running: boolean }>();
  constructor(private readonly report: (id: string) => void) {}
  request(id: string, stop: () => Promise<unknown>): void {
    if (this.pending.has(id)) return;
    this.pending.set(id, { stop, attempts: 0, running: false });
    void this.attempt(id);
  }
  has(id: string): boolean { return this.pending.has(id); }
  acknowledgeRemoved(id: string): void { this.pending.delete(id); }
  private async attempt(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.running) return;
    pending.running = true; pending.attempts++;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending.stop(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Scheduled job stop did not finish')), 30_000);
      })]);
      this.pending.delete(id);
    } catch {
      if (this.pending.get(id) !== pending) return;
      this.report(id);
      // Three bounded attempts. Exhausted entries deliberately stay owned and visible.
      if (pending.attempts < 3) setTimeout(() => { void this.attempt(id); }, 5_000).unref?.();
    } finally {
      if (timeout) clearTimeout(timeout);
      pending.running = false;
    }
  }
}
