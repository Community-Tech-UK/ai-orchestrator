/**
 * One-shot text for the turn after one was interrupted. Two kinds are held
 * apart, so neither replaces the other:
 * - the context the Continue button sends with (`instance-send-continuation.ts`);
 * - the note Harness leaves after stopping a repeating turn
 *   (`instance-tool-loop-wiring.ts`). Pressing Continue after that stop must
 *   still deliver the note, or the model gets only "continue" and repeats itself.
 * Both are separate from replay/compaction recovery, so a manual Continue cannot
 * overwrite either. When both are pending the note comes first.
 */
interface Pending { value: string; generation: number }

export class InterruptedContextQueue {
  private static instance: InterruptedContextQueue | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly stopNotes = new Map<string, Pending>();
  private generation = 0;

  static getInstance(): InterruptedContextQueue {
    return this.instance ??= new InterruptedContextQueue();
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /** Continue-button context. Returns a discard for a send that was rejected. */
  queue(instanceId: string, value: string): (() => void) | undefined {
    return this.put(this.pending, instanceId, value);
  }

  /** Harness's note after stopping a repeating turn; a newer note replaces an older one. */
  queueStopNote(instanceId: string, note: string): void {
    this.put(this.stopNotes, instanceId, note);
  }

  /** A restart the user chose starts a new conversation, which has no previous turn for the note to describe. */
  dropStopNote(instanceId: string): void {
    this.stopNotes.delete(instanceId);
  }

  prepare(instanceId: string): { value?: string; commit(): void } {
    const note = this.stopNotes.get(instanceId);
    const context = this.pending.get(instanceId);
    const parts = [note?.value, context?.value].filter((part): part is string => Boolean(part));
    return {
      value: parts.length > 0 ? parts.join('\n\n') : undefined,
      commit: () => {
        deleteIfCurrent(this.stopNotes, instanceId, note);
        deleteIfCurrent(this.pending, instanceId, context);
      },
    };
  }

  cleanup(instanceId: string): void {
    this.pending.delete(instanceId);
    this.stopNotes.delete(instanceId);
  }

  private put(map: Map<string, Pending>, instanceId: string, value: string): (() => void) | undefined {
    if (!value.trim()) return undefined;
    const entry = { value, generation: ++this.generation };
    map.set(instanceId, entry);
    return () => deleteIfCurrent(map, instanceId, entry);
  }
}

/** Remove `sent` unless something newer was queued while it was being sent. */
function deleteIfCurrent(map: Map<string, Pending>, instanceId: string, sent: Pending | undefined): void {
  if (sent && map.get(instanceId)?.generation === sent.generation) map.delete(instanceId);
}

export function getInterruptedContextQueue(): InterruptedContextQueue {
  return InterruptedContextQueue.getInstance();
}
