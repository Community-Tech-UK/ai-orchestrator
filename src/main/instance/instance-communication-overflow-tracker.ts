import type { FileAttachment } from '../../shared/types/instance.types';

export interface LastSentTurn {
  message: string;
  attachments?: FileAttachment[];
  contextBlock?: string | null;
}

/**
 * Per-instance overflow / last-turn bookkeeping for InstanceCommunicationManager.
 * Compaction and retry policy live on InstanceCommunicationOverflowPolicy; this object owns the maps.
 */
export class InstanceCommunicationOverflowTracker {
  private readonly lastSent = new Map<string, LastSentTurn>();
  private readonly warningIssued = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly seen = new Set<string>();

  rememberLastSent(instanceId: string, turn: LastSentTurn): void {
    this.lastSent.set(instanceId, turn);
  }

  getLastSent(instanceId: string): LastSentTurn | undefined {
    return this.lastSent.get(instanceId);
  }

  getResumePrompt(instanceId: string): string | null {
    return this.lastSent.get(instanceId)?.message ?? null;
  }

  hasWarning(instanceId: string): boolean {
    return this.warningIssued.has(instanceId);
  }

  markWarning(instanceId: string): void {
    this.warningIssued.add(instanceId);
  }

  clearWarning(instanceId: string): void {
    this.warningIssued.delete(instanceId);
  }

  hasRetried(instanceId: string): boolean {
    return this.retried.has(instanceId);
  }

  markRetried(instanceId: string): void {
    this.retried.add(instanceId);
  }

  clearRetry(instanceId: string): void {
    this.retried.delete(instanceId);
  }

  hasSeen(instanceId: string): boolean {
    return this.seen.has(instanceId);
  }

  markSeen(instanceId: string): void {
    this.seen.add(instanceId);
  }

  cleanup(instanceId: string): void {
    this.lastSent.delete(instanceId);
    this.warningIssued.delete(instanceId);
    this.retried.delete(instanceId);
    this.seen.delete(instanceId);
  }
}
