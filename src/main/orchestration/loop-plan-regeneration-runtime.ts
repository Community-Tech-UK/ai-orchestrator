/**
 * Disposable-plan regeneration on stall (LF-4), with its attempt bookkeeping.
 *
 * Extracted from `loop-coordinator.ts` to keep that file inside its size
 * ceiling. Behaviour is unchanged: the pure decision still lives in
 * `applyLoopPlanRegenerationOnStall`; this owns the counter and the logging.
 */

import { getLogger } from '../logging/logger';
import { applyLoopPlanRegenerationOnStall } from './loop-coordinator-state-helpers';
import type { LoopState } from '../../shared/types/loop.types';

const logger = getLogger('LoopCoordinator');

export function regenerateLoopPlanOnStall(args: {
  state: LoopState;
  seq: number;
  done: number;
  setDone: (count: number) => void;
  emit: (eventName: string, payload: unknown) => boolean;
}): boolean {
  const { state, seq, done } = args;
  const regenerated = applyLoopPlanRegenerationOnStall({ state, seq, done, emit: args.emit });
  if (!regenerated) {
    if (state.config.plan?.regenerateOnStall) {
      logger.info('Loop disposable-plan regeneration cap reached — pausing', {
        loopRunId: state.id,
        attempts: done,
      });
    }
    return false;
  }
  args.setDone(done + 1);
  logger.info('Loop disposable-plan regeneration injected on stall', {
    loopRunId: state.id,
    seq,
    attempt: done + 1,
  });
  return true;
}
