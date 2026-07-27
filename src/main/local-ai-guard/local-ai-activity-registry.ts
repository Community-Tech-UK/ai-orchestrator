export class LocalAiActivityRegistry {
  private readonly leaseCounts = new Map<string, number>();

  acquire(targetId: string): () => void {
    this.leaseCounts.set(targetId, (this.leaseCounts.get(targetId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.leaseCounts.get(targetId) ?? 1) - 1;
      if (remaining > 0) {
        this.leaseCounts.set(targetId, remaining);
      } else {
        this.leaseCounts.delete(targetId);
      }
    };
  }

  isBusy(targetId: string): boolean {
    return (this.leaseCounts.get(targetId) ?? 0) > 0;
  }
}
