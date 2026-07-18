type LoopCapKind = 'iterations' | 'wall-time' | 'tokens' | 'cost';

/** Owns transient completion/convergence hints that do not belong in LoopState. */
export class LoopCompletionContextStore {
  private convergenceNotes = new Map<string, string>();
  private planRegenerations = new Map<string, number>();
  private pendingContextResets = new Set<string>();
  private pendingFailovers = new Map<string, string>();
  private downshiftModels = new Map<string, string>();
  private capWrapUps = new Map<string, LoopCapKind>();
  private envelopeRewraps = new Map<string, number>();

  setConvergenceNote(loopRunId: string, note: string): void {
    this.convergenceNotes.set(loopRunId, note);
  }

  getConvergenceNote(loopRunId: string): string | undefined {
    return this.convergenceNotes.get(loopRunId);
  }

  hasConvergenceNote(loopRunId: string): boolean {
    return this.convergenceNotes.has(loopRunId);
  }

  setPlanRegenerationCount(loopRunId: string, count: number): void {
    this.planRegenerations.set(loopRunId, count);
  }

  getPlanRegenerationCount(loopRunId: string): number {
    return this.planRegenerations.get(loopRunId) ?? 0;
  }

  requestContextReset(loopRunId: string): void {
    this.pendingContextResets.add(loopRunId);
  }

  consumeContextReset(loopRunId: string): boolean {
    const pending = this.pendingContextResets.has(loopRunId);
    this.pendingContextResets.delete(loopRunId);
    return pending;
  }

  setPendingFailover(loopRunId: string, provider: string): void {
    this.pendingFailovers.set(loopRunId, provider);
  }

  consumePendingFailover(loopRunId: string): string | undefined {
    const provider = this.pendingFailovers.get(loopRunId);
    this.pendingFailovers.delete(loopRunId);
    return provider;
  }

  peekPendingFailover(loopRunId: string): string | undefined {
    return this.pendingFailovers.get(loopRunId);
  }

  setDownshiftModel(loopRunId: string, model: string): void {
    this.downshiftModels.set(loopRunId, model);
  }

  getDownshiftModel(loopRunId: string): string | undefined {
    return this.downshiftModels.get(loopRunId);
  }

  clearDownshiftModel(loopRunId: string): void {
    this.downshiftModels.delete(loopRunId);
  }

  setCapWrapUp(loopRunId: string, cap: LoopCapKind): void {
    this.capWrapUps.set(loopRunId, cap);
  }

  getCapWrapUp(loopRunId: string): LoopCapKind | undefined {
    return this.capWrapUps.get(loopRunId);
  }

  setEnvelopeRewrapCount(loopRunId: string, count: number): void {
    this.envelopeRewraps.set(loopRunId, count);
  }

  getEnvelopeRewrapCount(loopRunId: string): number {
    return this.envelopeRewraps.get(loopRunId) ?? 0;
  }

  convergenceNotesForHelpers(): Map<string, string> {
    return this.convergenceNotes;
  }

  pendingContextResetsForHelpers(): Set<string> {
    return this.pendingContextResets;
  }

  clearRun(loopRunId: string): void {
    this.convergenceNotes.delete(loopRunId);
    this.planRegenerations.delete(loopRunId);
    this.pendingContextResets.delete(loopRunId);
    this.pendingFailovers.delete(loopRunId);
    this.downshiftModels.delete(loopRunId);
    this.capWrapUps.delete(loopRunId);
    this.envelopeRewraps.delete(loopRunId);
  }

  reset(): void {
    this.convergenceNotes.clear();
    this.planRegenerations.clear();
    this.pendingContextResets.clear();
    this.pendingFailovers.clear();
    this.downshiftModels.clear();
    this.capWrapUps.clear();
    this.envelopeRewraps.clear();
  }
}
