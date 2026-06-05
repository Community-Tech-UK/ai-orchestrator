import type { LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { distillLearning, type LoopMemoryStore } from './loop-memory';

const logger = getLogger('LoopLearningRecorder');

export function recordLoopLearningForState(opts: {
  state: LoopState;
  status: string;
  note: string | undefined;
  store: LoopMemoryStore;
}): void {
  const { state, status, note, store } = opts;
  try {
    const record = distillLearning({
      workspaceCwd: state.config.workspaceCwd,
      goal: state.config.initialPrompt,
      status,
      reason: state.endReason ?? note ?? status,
      lastCompletionOutcome: state.lastCompletionOutcome,
      deadEnds: note ? [note] : [],
    });
    void Promise.resolve(store.recordLearning(record)).catch((err) => {
      logger.warn('recordLoopLearning persist failed', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    logger.warn('recordLoopLearning threw', { loopRunId: state.id, error: String(err) });
  }
}
