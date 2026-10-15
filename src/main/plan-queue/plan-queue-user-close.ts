/** Short-lived intent marks distinguish a deliberate close from a worker crash. */
export class PlanQueueUserClose {
  private readonly closing = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  note(ids: readonly string[]): void {
    const now = this.now();
    for (const [id, at] of this.closing) if (now - at > 120_000) this.closing.delete(id);
    for (const id of ids) this.closing.set(id, now);
  }
  consume(id: string): boolean {
    const at = this.closing.get(id);
    this.closing.delete(id);
    return at !== undefined && this.now() - at <= 120_000;
  }
}

/** A spawn already queued before Close all must not create a replacement session. */
export class PlanQueueSpawnStoppedByUser extends Error {
  constructor() { super('Plan Queue session creation stopped by Close all'); }
}
