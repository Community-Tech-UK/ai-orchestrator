import { getLogger } from '../logging/logger';
import type {
  LoopState,
  LoopWorktreeLifecycle,
} from '../../shared/types/loop.types';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import { getLoopStore } from './loop-store';
import { finalizeLoopWorktree } from './loop-worktree-lifecycle';

const logger = getLogger('LoopCoordinator');

export function cleanupLoopWorktreeAfterTerminate(args: {
  state: LoopState;
  status: LoopState['status'];
  worktreeSessionId: string | undefined;
  getTerminalCleanup: (loopRunId: string) => Promise<void> | undefined;
  onTransition?: (lifecycle: LoopWorktreeLifecycle) => void;
}): void {
  const {
    state,
    status,
    worktreeSessionId,
    getTerminalCleanup,
    onTransition,
  } = args;
  if (!worktreeSessionId) return;

  void finalizeLoopWorktree({
    state,
    status,
    worktreeSessionId,
    manager: getWorktreeManager(),
    store: getLoopStore(),
    awaitAdapterCleanup: async () => {
      // Let terminate() register its adapter cleanup promise before querying it.
      await Promise.resolve();
      await getTerminalCleanup(state.id);
    },
    onTransition,
  }).catch((error) => {
    logger.warn('Loop terminate: worktree finalization failed', {
      loopRunId: state.id,
      worktreeSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
