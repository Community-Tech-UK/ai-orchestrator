import type { LoopIteration, LoopState } from '../../shared/types/loop.types';
import type { PauseGate } from './loop-coordinator.types';

/**
 * Owns the mutable registries that describe a loop run's process lifecycle.
 * Completion/convergence state intentionally lives elsewhere: this class only
 * coordinates registration, cancellation, pause gates, and terminal resources.
 */
export class LoopLifecycleStateManager {
  private states = new Map<string, LoopState>();
  private histories = new Map<string, LoopIteration[]>();
  private cancellations = new Map<string, boolean>();
  private pauseGates = new Map<string, PauseGate>();
  private terminalCleanups = new Map<string, Promise<void>>();
  private worktreeSessions = new Map<string, string>();

  register(state: LoopState, history: LoopIteration[]): void {
    this.states.set(state.id, state);
    this.histories.set(state.id, history);
    this.cancellations.set(state.id, false);
  }

  getState(loopRunId: string): LoopState | undefined {
    return this.states.get(loopRunId);
  }

  listStates(): LoopState[] {
    return Array.from(this.states.values());
  }

  historyFor(loopRunId: string): LoopIteration[] {
    return this.histories.get(loopRunId) ?? [];
  }

  setCancelled(loopRunId: string, cancelled: boolean): void {
    this.cancellations.set(loopRunId, cancelled);
  }

  isCancelled(loopRunId: string): boolean {
    return this.cancellations.get(loopRunId) === true;
  }

  waitUntilResumed(loopRunId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pauseGates.set(loopRunId, { resolve });
    });
  }

  releasePause(loopRunId: string): boolean {
    const gate = this.pauseGates.get(loopRunId);
    if (!gate) return false;
    this.pauseGates.delete(loopRunId);
    gate.resolve();
    return true;
  }

  setTerminalCleanup(loopRunId: string, cleanup: Promise<void>): void {
    this.terminalCleanups.set(loopRunId, cleanup);
  }

  getTerminalCleanup(loopRunId: string): Promise<void> | undefined {
    return this.terminalCleanups.get(loopRunId);
  }

  clearTerminalCleanup(loopRunId: string, expected: Promise<void>): boolean {
    if (this.terminalCleanups.get(loopRunId) !== expected) return false;
    this.terminalCleanups.delete(loopRunId);
    return true;
  }

  setWorktreeSession(loopRunId: string, sessionId: string): void {
    this.worktreeSessions.set(loopRunId, sessionId);
  }

  hasWorktreeSession(loopRunId: string): boolean {
    return this.worktreeSessions.has(loopRunId);
  }

  takeWorktreeSession(loopRunId: string): string | undefined {
    const sessionId = this.worktreeSessions.get(loopRunId);
    this.worktreeSessions.delete(loopRunId);
    return sessionId;
  }

  /** Temporary compatibility seam for existing coordinator black-box specs. */
  statesForTesting(): Map<string, LoopState> {
    return this.states;
  }

  reset(): void {
    for (const gate of this.pauseGates.values()) gate.resolve();
    this.states.clear();
    this.histories.clear();
    this.cancellations.clear();
    this.pauseGates.clear();
    this.terminalCleanups.clear();
    this.worktreeSessions.clear();
  }
}
