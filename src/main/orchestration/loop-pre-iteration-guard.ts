import {
  createLoopPendingInput,
  type LoopState,
} from '../../shared/types/loop.types';
import {
  buildCapWrapUpDirective,
  checkLoopHardCaps,
  describeLoopCapReason,
} from './loop-coordinator-state-helpers';
import {
  isParkedLoopRuntimeState,
  isTerminalLoopRuntimeState,
} from './loop-runtime-status';

type LoopCap = 'iterations' | 'wall-time' | 'tokens' | 'cost';
type PreIterationResult = 'continue' | 'restart' | 'terminal';

interface LoopPreIterationGuardDependencies {
  isCancelled(loopRunId: string): boolean;
  waitWhilePaused(loopRunId: string): Promise<void>;
  maintenanceActive(): boolean;
  getConvergenceNote(loopRunId: string): string | undefined;
  getCapWrapUp(loopRunId: string): LoopCap | undefined;
  setCapWrapUp(loopRunId: string, cap: LoopCap): void;
  terminate(state: LoopState, status: LoopState['status'], reason?: string): void;
  emit(eventName: string, payload: unknown): void;
  sleep(delayMs: number): Promise<void>;
  onCapWrapUp?(loopRunId: string, cap: LoopCap): void;
}

/**
 * Owns the checks that must run before a loop starts another paid iteration.
 * The guard mutates only the cap wrap-up intervention; lifecycle ownership
 * remains with the coordinator through the injected callbacks.
 */
export class LoopPreIterationGuard {
  constructor(private readonly dependencies: LoopPreIterationGuardDependencies) {}

  async run(state: LoopState): Promise<PreIterationResult> {
    if (isTerminalLoopRuntimeState(state) || this.dependencies.isCancelled(state.id)) {
      this.dependencies.terminate(state, 'cancelled');
      return 'terminal';
    }

    if (isParkedLoopRuntimeState(state)) {
      await this.dependencies.waitWhilePaused(state.id);
      if (this.dependencies.isCancelled(state.id)) {
        this.dependencies.terminate(state, 'cancelled');
        return 'terminal';
      }
    }

    if (this.dependencies.maintenanceActive()) {
      await this.dependencies.sleep(100);
      return 'restart';
    }

    const cap = checkLoopHardCaps(state);
    if (!cap) return 'continue';

    const reason = describeLoopCapReason(
      state,
      cap,
      this.dependencies.getConvergenceNote(state.id),
    );
    const wrapUpEnabled = state.config.caps.capWrapUpIteration ?? true;
    if (
      wrapUpEnabled &&
      !this.dependencies.getCapWrapUp(state.id) &&
      state.status === 'running'
    ) {
      this.dependencies.setCapWrapUp(state.id, cap);
      state.pendingInterventions.push(
        createLoopPendingInput(buildCapWrapUpDirective(cap, reason), { source: 'cap-wrap-up' }),
      );
      this.dependencies.emit('loop:cap-wrap-up', { loopRunId: state.id, cap, reason });
      this.dependencies.onCapWrapUp?.(state.id, cap);
      return 'continue';
    }

    this.dependencies.emit('loop:cap-reached', { loopRunId: state.id, cap, reason });
    this.dependencies.terminate(state, 'cap-reached', reason);
    return 'terminal';
  }
}
