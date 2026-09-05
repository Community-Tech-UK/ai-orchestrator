import {
  createLoopPendingInput,
  type LoopCapWrapUpIntent,
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
import { providerEnforcesWrapUpToolsDisable } from './loop-tools-disable';

type LoopCap = LoopCapWrapUpIntent['cap'];
type PreIterationResult = 'continue' | 'restart' | 'terminal';

/**
 * T45 (Decision 4) — caps whose wrap-up turn is skipped.
 *
 * The wrap-up is one extra paid iteration so a capped run ends with a
 * structured hand-off instead of an abrupt cut. That trade only makes sense
 * when the thing that ran out is iterations or wall time. A run that has
 * already blown its TOKEN or COST cap would pay another full scaffold to
 * overshoot the very budget that stopped it, which is the opposite of what the
 * cap is for.
 */
const CAPS_WITHOUT_WRAP_UP: ReadonlySet<LoopCap> = new Set<LoopCap>(['tokens', 'cost']);

interface LoopPreIterationGuardDependencies {
  isCancelled(loopRunId: string): boolean;
  waitWhilePaused(loopRunId: string): Promise<void>;
  maintenanceActive(): boolean;
  getConvergenceNote(loopRunId: string): string | undefined;
  getCapWrapUp(loopRunId: string): LoopCapWrapUpIntent | undefined;
  setCapWrapUp(loopRunId: string, intent: LoopCapWrapUpIntent): void;
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

    const existingIntent = this.dependencies.getCapWrapUp(state.id) ?? state.capWrapUpIntent;
    const cap = checkLoopHardCaps(state) ?? existingIntent?.cap ?? null;
    if (!cap) return 'continue';

    const reason = existingIntent?.originalReason ?? describeLoopCapReason(
      state,
      cap,
      this.dependencies.getConvergenceNote(state.id),
    );
    // T45: the wrap-up is only a hand-off if "do not start new work" is
    // enforced. On a prompt-only provider the child keeps every tool and may
    // start work it will never finish, so the extra paid turn is pure waste —
    // the last NOTES.md is the hand-off instead.
    const wrapUpEnabled = (state.config.caps.capWrapUpIteration ?? true)
      && !CAPS_WITHOUT_WRAP_UP.has(cap)
      && providerEnforcesWrapUpToolsDisable(state.config.provider);
    if (
      wrapUpEnabled &&
      !existingIntent &&
      state.status === 'running'
    ) {
      const intent = createCapWrapUpIntent(state, cap, reason);
      state.capWrapUpIntent = intent;
      this.dependencies.setCapWrapUp(state.id, intent);
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

function createCapWrapUpIntent(
  state: LoopState,
  cap: LoopCap,
  originalReason: string,
): LoopCapWrapUpIntent {
  const measurementAndLimit = (() => {
    switch (cap) {
      case 'iterations':
        return { measurement: state.totalIterations, limit: state.config.caps.maxIterations ?? undefined };
      case 'wall-time':
        return { measurement: Date.now() - state.startedAt, limit: state.config.caps.maxWallTimeMs ?? undefined };
      case 'tokens':
        return { measurement: state.totalTokens, limit: state.config.caps.maxTokens ?? undefined };
      case 'cost':
        return { measurement: state.totalCostCents, limit: state.config.caps.maxCostCents ?? undefined };
    }
  })();
  return {
    cap,
    originalReason,
    triggerIteration: state.totalIterations,
    ...(typeof measurementAndLimit.measurement === 'number'
      ? { measurement: measurementAndLimit.measurement }
      : {}),
    ...(typeof measurementAndLimit.limit === 'number' ? { limit: measurementAndLimit.limit } : {}),
    phase: 'pending-turn',
  };
}
