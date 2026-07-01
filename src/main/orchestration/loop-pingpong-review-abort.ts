import { combineAbortSignals } from '../util/abort-signals';

export interface LoopReviewAbortHandle {
  readonly signal: AbortSignal;
  cleanup(): void;
}

export class LoopPingPongReviewAbortRegistry {
  private pauseControllers = new Map<string, Set<AbortController>>();
  private terminalControllers = new Map<string, Set<AbortController>>();

  create(loopRunId: string): LoopReviewAbortHandle {
    const pauseController = new AbortController();
    const terminalController = new AbortController();
    this.getSet(this.pauseControllers, loopRunId).add(pauseController);
    this.getSet(this.terminalControllers, loopRunId).add(terminalController);

    return {
      signal: combineAbortSignals([pauseController.signal, terminalController.signal]),
      cleanup: () => {
        this.deleteController(this.pauseControllers, loopRunId, pauseController);
        this.deleteController(this.terminalControllers, loopRunId, terminalController);
      },
    };
  }

  abortPause(loopRunId: string, reason: unknown): void {
    this.abortSet(this.pauseControllers, loopRunId, reason);
  }

  abortTerminal(loopRunId: string, reason: unknown): void {
    this.abortSet(this.terminalControllers, loopRunId, reason);
  }

  abortAll(reason: unknown): void {
    for (const loopRunId of this.pauseControllers.keys()) {
      this.abortPause(loopRunId, reason);
    }
    for (const loopRunId of this.terminalControllers.keys()) {
      this.abortTerminal(loopRunId, reason);
    }
  }

  clear(): void {
    this.pauseControllers.clear();
    this.terminalControllers.clear();
  }

  private getSet(
    map: Map<string, Set<AbortController>>,
    loopRunId: string,
  ): Set<AbortController> {
    let set = map.get(loopRunId);
    if (!set) {
      set = new Set<AbortController>();
      map.set(loopRunId, set);
    }
    return set;
  }

  private deleteController(
    map: Map<string, Set<AbortController>>,
    loopRunId: string,
    controller: AbortController,
  ): void {
    const set = map.get(loopRunId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) {
      map.delete(loopRunId);
    }
  }

  private abortSet(
    map: Map<string, Set<AbortController>>,
    loopRunId: string,
    reason: unknown,
  ): void {
    const set = map.get(loopRunId);
    if (!set) return;
    map.delete(loopRunId);
    for (const controller of set) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    }
  }
}
