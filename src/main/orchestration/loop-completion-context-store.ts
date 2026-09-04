import type { LoopCapWrapUpIntent } from '../../shared/types/loop.types';

/** Owns transient completion/convergence hints that do not belong in LoopState. */
export class LoopCompletionContextStore {
  private convergenceNotes = new Map<string, string>();
  private planRegenerations = new Map<string, number>();
  private pendingContextResets = new Set<string>();
  private pendingFailovers = new Map<string, string>();
  private downshiftModels = new Map<string, string>();
  private capWrapUps = new Map<string, LoopCapWrapUpIntent>();
  private envelopeRewraps = new Map<string, number>();
  private autoUnstickCounts = new Map<string, number>();

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

  peekContextReset(loopRunId: string): boolean {
    return this.pendingContextResets.has(loopRunId);
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

  setCapWrapUp(loopRunId: string, intent: LoopCapWrapUpIntent): void {
    this.capWrapUps.set(loopRunId, { ...intent });
  }

  getCapWrapUp(loopRunId: string): LoopCapWrapUpIntent | undefined {
    const intent = this.capWrapUps.get(loopRunId);
    return intent ? { ...intent } : undefined;
  }

  setEnvelopeRewrapCount(loopRunId: string, count: number): void {
    this.envelopeRewraps.set(loopRunId, count);
  }

  getEnvelopeRewrapCount(loopRunId: string): number {
    return this.envelopeRewraps.get(loopRunId) ?? 0;
  }

  setAutoUnstickCount(loopRunId: string, count: number): void {
    this.autoUnstickCounts.set(loopRunId, count);
  }

  getAutoUnstickCount(loopRunId: string): number {
    return this.autoUnstickCounts.get(loopRunId) ?? 0;
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
    this.autoUnstickCounts.delete(loopRunId);
  }

  reset(): void {
    this.convergenceNotes.clear();
    this.planRegenerations.clear();
    this.pendingContextResets.clear();
    this.pendingFailovers.clear();
    this.downshiftModels.clear();
    this.capWrapUps.clear();
    this.envelopeRewraps.clear();
    this.autoUnstickCounts.clear();
  }
}
