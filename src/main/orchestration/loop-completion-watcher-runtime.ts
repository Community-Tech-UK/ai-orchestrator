import { getLogger } from '../logging/logger';
import type { LoopState } from '../../shared/types/loop.types';
import { CompletedFileWatcher, isCompletedRenameForPlan } from './loop-completion-detector';

const logger = getLogger('LoopCoordinator');

export type LoopCompletionWatcherEmit = (eventName: string, payload: unknown) => boolean;

export function wireLoopCompletionWatcher(
  watcher: CompletedFileWatcher,
  state: LoopState,
  emit: LoopCompletionWatcherEmit,
): void {
  watcher.onCompleted((filePath) => {
    if (!isCompletedRenameForPlan(state.config, filePath)) {
      logger.info('CompletedFileWatcher ignored a *_completed.md rename not matching this loop\'s plan', {
        id: state.id,
        filePath,
        planFile: state.config.planFile ?? null,
      });
      return;
    }
    state.completedFileRenameObserved = true;
    logger.info('CompletedFileWatcher fired', { id: state.id, filePath });
    emit('loop:completed-file-observed', { loopRunId: state.id, filePath });
  });

  watcher.onUndone((filePath) => {
    if (!state.completedFileRenameObserved) return;
    if (!isCompletedRenameForPlan(state.config, filePath)) return;
    state.completedFileRenameObserved = false;
    logger.info('CompletedFileWatcher undone', { id: state.id, filePath });
    emit('loop:completed-file-undone', { loopRunId: state.id, filePath });
  });
}
