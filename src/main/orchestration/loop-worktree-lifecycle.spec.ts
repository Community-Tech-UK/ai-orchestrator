import { describe, expect, it, vi } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import {
  finalizeLoopWorktree,
  type LoopWorktreeFinalizerManager,
  type LoopWorktreeLifecycleStore,
} from './loop-worktree-lifecycle';

function makeState(status: LoopState['status'] = 'completed'): LoopState {
  return {
    id: 'loop-1',
    status,
    config: {
      workspaceCwd: '/repo',
      worktreeBranch: 'task-loop-1',
      worktreeBaseBranch: 'main',
      autoIntegrateWorktree: true,
    },
    worktreeLifecycle: {
      managedByAio: true,
      phase: 'acquired',
      baseBranch: 'main',
      sessionBranch: 'task-loop-1',
      sessionTip: 'base-tip',
      updatedAt: 1,
    },
  } as unknown as LoopState;
}

function makeManager(
  overrides: Partial<LoopWorktreeFinalizerManager> = {},
): LoopWorktreeFinalizerManager {
  return {
    harvestWorktree: vi.fn().mockResolvedValue({
      committed: true,
      hasUncommittedWork: true,
      hash: 'harvest',
    }),
    integrateWorktree: vi.fn().mockResolvedValue({
      success: true,
      integrationBranch: 'integration/main',
      mergeCommit: 'merged',
    }),
    promoteWorktreeIntegration: vi.fn().mockResolvedValue({
      status: 'promoted',
      method: 'checked-out-ff',
      tip: 'merged',
    }),
    abandonWorktree: vi.fn().mockResolvedValue(undefined),
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeStore(): LoopWorktreeLifecycleStore {
  return {
    updateWorktreeLifecycle: vi.fn(),
    clearWorktreeInfo: vi.fn(),
  };
}

describe('finalizeLoopWorktree', () => {
  it('persists harvest, integration, promotion, and cleanup in order', async () => {
    const state = makeState();
    const manager = makeManager();
    const store = makeStore();
    const phases: string[] = [];

    await finalizeLoopWorktree({
      state,
      status: 'completed',
      worktreeSessionId: 'wt-1',
      manager,
      store,
      awaitAdapterCleanup: vi.fn().mockResolvedValue(undefined),
      onTransition: (lifecycle) => phases.push(lifecycle.phase),
    });

    expect(phases).toEqual([
      'harvesting',
      'harvested',
      'integrating',
      'integrated',
      'promoting',
      'promoted',
      'cleaned',
    ]);
    expect(manager.cleanupWorktree).toHaveBeenCalledWith('wt-1');
    expect(manager.promoteWorktreeIntegration).toHaveBeenCalledWith(
      'wt-1',
      'integration/main',
      'merged',
    );
    expect(
      vi.mocked(store.updateWorktreeLifecycle).mock.invocationCallOrder.find(
        (_, index) =>
          vi.mocked(store.updateWorktreeLifecycle).mock.calls[index]?.[1].phase === 'promoting',
      ),
    ).toBeLessThan(
      vi.mocked(manager.promoteWorktreeIntegration).mock.invocationCallOrder[0],
    );
    expect(store.clearWorktreeInfo).toHaveBeenCalledWith('loop-1');
    expect(state.worktreeLifecycle?.phase).toBe('cleaned');
  });

  it('blocks and retains a dirty worktree when harvest cannot commit it', async () => {
    const state = makeState();
    const manager = makeManager({
      harvestWorktree: vi.fn().mockResolvedValue({
        committed: false,
        hasUncommittedWork: true,
      }),
    });
    const store = makeStore();

    await finalizeLoopWorktree({
      state,
      status: 'completed',
      worktreeSessionId: 'wt-1',
      manager,
      store,
    });

    expect(state.worktreeLifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'Harvest failed with uncommitted work',
    });
    expect(manager.integrateWorktree).not.toHaveBeenCalled();
    expect(manager.cleanupWorktree).not.toHaveBeenCalled();
    expect(store.clearWorktreeInfo).not.toHaveBeenCalled();
  });

  it('keeps both branch refs visible when promotion is blocked', async () => {
    const state = makeState();
    const manager = makeManager({
      promoteWorktreeIntegration: vi.fn().mockResolvedValue({
        status: 'blocked',
        reason: 'root checkout has uncommitted changes',
      }),
    });
    const store = makeStore();

    await finalizeLoopWorktree({
      state,
      status: 'completed',
      worktreeSessionId: 'wt-1',
      manager,
      store,
    });

    expect(state.worktreeLifecycle).toMatchObject({
      phase: 'blocked',
      sessionBranch: 'task-loop-1',
      integrationBranch: 'integration/main',
      lastError: 'root checkout has uncommitted changes',
    });
    expect(manager.cleanupWorktree).toHaveBeenCalledWith('wt-1', {
      retainBranch: true,
    });
    expect(store.clearWorktreeInfo).toHaveBeenCalledWith('loop-1');
  });

  it('turns an unexpected integration error into a retryable blocked state', async () => {
    const state = makeState();
    const manager = makeManager({
      integrateWorktree: vi.fn().mockRejectedValue(new Error('git lock unavailable')),
    });
    const store = makeStore();

    await finalizeLoopWorktree({
      state,
      status: 'completed',
      worktreeSessionId: 'wt-1',
      manager,
      store,
    });

    expect(state.worktreeLifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'Managed worktree finalization failed; inspect AIO logs',
    });
    expect(manager.cleanupWorktree).not.toHaveBeenCalled();
    expect(store.clearWorktreeInfo).not.toHaveBeenCalled();
  });

  it('preserves a cancelled run on its session branch before cleaning the directory', async () => {
    const state = makeState('cancelled');
    const manager = makeManager();
    const store = makeStore();
    const phases: string[] = [];

    await finalizeLoopWorktree({
      state,
      status: 'cancelled',
      worktreeSessionId: 'wt-1',
      manager,
      store,
      onTransition: (lifecycle) => phases.push(lifecycle.phase),
    });

    expect(phases).toEqual(['harvesting', 'harvested', 'preserved', 'cleaned']);
    expect(manager.integrateWorktree).not.toHaveBeenCalled();
    expect(manager.abandonWorktree).toHaveBeenCalledWith('wt-1', 'loop-cancelled');
    expect(manager.cleanupWorktree).toHaveBeenCalledWith('wt-1', {
      retainBranch: true,
    });
  });
});
