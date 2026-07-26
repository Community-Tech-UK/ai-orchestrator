import type {
  LoopState,
  LoopWorktreeLifecycle,
} from '../../shared/types/loop.types';
import type { BasePromotionResult } from '../workspace/git/worktree-integration';
import { getLogger } from '../logging/logger';

const logger = getLogger('LoopWorktreeLifecycle');

export interface LoopWorktreeFinalizerManager {
  harvestWorktree(
    worktreeId: string,
  ): Promise<{ committed: boolean; hasUncommittedWork: boolean; hash?: string }>;
  integrateWorktree(
    worktreeId: string,
    options?: Record<string, never>,
  ): Promise<{
    success: boolean;
    integrationBranch: string;
    mergeCommit?: string;
    alreadyIntegrated?: boolean;
    error?: string;
    conflictFiles?: string[];
  }>;
  promoteWorktreeIntegration(
    worktreeId: string,
    integrationBranch: string,
    expectedIntegrationTip?: string,
  ): Promise<BasePromotionResult>;
  abandonWorktree(worktreeId: string, reason?: string): Promise<unknown>;
  cleanupWorktree(
    worktreeId: string,
    options?: { force?: boolean; retainBranch?: boolean },
  ): Promise<void>;
}

export interface LoopWorktreeLifecycleStore {
  updateWorktreeLifecycle(loopRunId: string, lifecycle: LoopWorktreeLifecycle): void;
  clearWorktreeInfo(loopRunId: string): void;
}

export interface FinalizeLoopWorktreeArgs {
  state: LoopState;
  status: LoopState['status'];
  worktreeSessionId: string;
  manager: LoopWorktreeFinalizerManager;
  store: LoopWorktreeLifecycleStore;
  awaitAdapterCleanup?: () => Promise<void>;
  onTransition?: (lifecycle: LoopWorktreeLifecycle) => void;
}

function lifecycleForState(state: LoopState): LoopWorktreeLifecycle {
  if (state.worktreeLifecycle?.managedByAio === true) {
    return state.worktreeLifecycle;
  }
  throw new Error('Managed worktree ownership metadata is missing');
}

/**
 * Complete the AIO-owned worktree pipeline with each meaningful boundary
 * persisted before the next Git mutation. The operation is intentionally
 * idempotent at the Git layer so boot recovery can retry an interrupted phase.
 */
export async function finalizeLoopWorktree(args: FinalizeLoopWorktreeArgs): Promise<void> {
  const {
    state,
    status,
    worktreeSessionId,
    manager,
    store,
    awaitAdapterCleanup,
    onTransition,
  } = args;

  let lifecycle = lifecycleForState(state);
  const transition = (
    phase: LoopWorktreeLifecycle['phase'],
    patch: Partial<LoopWorktreeLifecycle> = {},
  ): void => {
    lifecycle = {
      ...lifecycle,
      ...patch,
      phase,
      updatedAt: Date.now(),
    };
    state.worktreeLifecycle = lifecycle;
    store.updateWorktreeLifecycle(state.id, lifecycle);
    onTransition?.(lifecycle);
  };

  try {
    if (awaitAdapterCleanup) {
      try {
        await awaitAdapterCleanup();
      } catch {
        // Adapter shutdown errors are already surfaced by the owner. Harvesting
        // is still the safest next action after the child has been asked to stop.
      }
    }

    transition('harvesting', { lastError: undefined });
    const harvest = await manager.harvestWorktree(worktreeSessionId);
    if (!harvest.committed && harvest.hasUncommittedWork) {
      transition('blocked', { lastError: 'Harvest failed with uncommitted work' });
      return;
    }
    transition('harvested', { sessionTip: harvest.hash });

    const isSuccess = status === 'completed' || status === 'completed-needs-review';
    if (!isSuccess || state.config.autoIntegrateWorktree === false) {
      transition('preserved');
      if (!isSuccess) {
        await manager.abandonWorktree(worktreeSessionId, `loop-${status}`);
      }
      await manager.cleanupWorktree(worktreeSessionId, { retainBranch: true });
      store.clearWorktreeInfo(state.id);
      transition('cleaned');
      return;
    }

    transition('integrating');
    const integration = await manager.integrateWorktree(worktreeSessionId);
    const integrationBranch = integration.integrationBranch;
    if (!integration.success) {
      logger.warn('Managed worktree integration blocked', {
        loopRunId: state.id,
        error: integration.error,
      });
      transition('blocked', {
        integrationBranch,
        lastError: 'Managed worktree integration failed; inspect AIO logs',
      });
      await manager.cleanupWorktree(worktreeSessionId, { retainBranch: true });
      store.clearWorktreeInfo(state.id);
      return;
    }

    const integrationTip = integration.mergeCommit;
    if (!integrationTip) {
      transition('blocked', {
        integrationBranch,
        lastError: 'Managed integration branch identity could not be verified',
      });
      return;
    }
    transition('integrated', { integrationBranch, integrationTip });
    transition('promoting');
    const promotion = await manager.promoteWorktreeIntegration(
      worktreeSessionId,
      integrationBranch,
      integrationTip,
    );
    if (promotion.status === 'blocked') {
      transition('blocked', {
        lastError:
          promotion.reason,
      });
      await manager.cleanupWorktree(worktreeSessionId, { retainBranch: true });
      store.clearWorktreeInfo(state.id);
      return;
    }

    transition('promoted');
    await manager.cleanupWorktree(worktreeSessionId);
    store.clearWorktreeInfo(state.id);
    transition('cleaned');
  } catch (error) {
    logger.warn('Managed worktree finalization blocked', {
      loopRunId: state.id,
      error: error instanceof Error ? error.message : String(error),
    });
    transition(
      lifecycle.phase === 'promoted' ? 'promoted' : 'blocked',
      { lastError: 'Managed worktree finalization failed; inspect AIO logs' },
    );
  }
}
