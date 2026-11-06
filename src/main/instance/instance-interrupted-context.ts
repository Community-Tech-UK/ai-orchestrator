/** Separate from replay/compaction recovery, so a manual Continue cannot overwrite either. */
export class InterruptedContextQueue {
  private static instance: InterruptedContextQueue | null = null;
  private readonly pending = new Map<string, { value: string; generation: number }>();
  private generation = 0;

  static getInstance(): InterruptedContextQueue {
    return this.instance ??= new InterruptedContextQueue();
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  queue(instanceId: string, value: string): (() => void) | undefined {
    if (!value.trim()) return undefined;
    const generation = ++this.generation;
    this.pending.set(instanceId, { value, generation });
    return () => {
      if (this.pending.get(instanceId)?.generation === generation) this.pending.delete(instanceId);
    };
  }

  prepare(instanceId: string): { value?: string; commit(): void } {
    const captured = this.pending.get(instanceId);
    return {
      value: captured?.value,
      commit: () => {
        if (captured && this.pending.get(instanceId)?.generation === captured.generation) this.pending.delete(instanceId);
      },
    };
  }

  cleanup(instanceId: string): void {
    this.pending.delete(instanceId);
  }
}

export function getInterruptedContextQueue(): InterruptedContextQueue {
  return InterruptedContextQueue.getInstance();
}
