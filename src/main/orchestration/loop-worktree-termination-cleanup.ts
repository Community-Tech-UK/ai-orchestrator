import { getLogger } from '../logging/logger';
import type {
  LoopState,
  LoopWorktreeLifecycle,
} from '../../shared/types/loop.types';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import { getLoopStore } from './loop-store';
import { finalizeLoopWorktree } from './loop-worktree-lifecycle';

const logger = getLogger('LoopCoordinator');

/** Worktree finalizations started by terminate() that have not settled yet. */
const inFlightFinalizations = new Map<string, Promise<void>>();

/**
 * Resolve once the loop's own worktree finalization (harvest → integrate →
 * promote → cleanup) has settled, or immediately when none is in flight. A
 * campaign node whose loop ran isolated lands into the campaign worktree this
 * way, so the campaign must not harvest that worktree before it settles.
 */
export function awaitLoopWorktreeFinalization(loopRunId: string): Promise<void> {
  return inFlightFinalizations.get(loopRunId) ?? Promise.resolve();
}

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

  const finalization: Promise<void> = finalizeLoopWorktree({
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
  }).finally(() => {
    if (inFlightFinalizations.get(state.id) === finalization) {
      inFlightFinalizations.delete(state.id);
    }
  });
  inFlightFinalizations.set(state.id, finalization);
}
