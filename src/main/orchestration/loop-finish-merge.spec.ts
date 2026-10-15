import { describe, expect, it, vi } from 'vitest';
import { finalizeLoopWorktree, type LoopWorktreeFinalizerManager } from './loop-worktree-lifecycle';
import type { LoopState } from '../../shared/types/loop.types';

describe('finish evidence merge hold', () => {
  it.each([true, false])('holds skipped checks only when mergeHold is %s', async (hold) => {
    const state = { id: 'finish', config: {}, endEvidence: { mergeHold: hold }, worktreeLifecycle: { managedByAio: true, phase: 'acquired', baseBranch: 'main', sessionBranch: 'loop', sessionTip: 'start', updatedAt: 0 } } as unknown as LoopState;
    const manager: LoopWorktreeFinalizerManager = { harvestWorktree: vi.fn().mockResolvedValue({ committed: true, hasUncommittedWork: false, hash: 'tip' }), listActivePlanDocuments: vi.fn().mockResolvedValue([]), integrateWorktree: vi.fn().mockResolvedValue({ success: true, integrationBranch: 'integration/main', mergeCommit: 'tip' }), promoteWorktreeIntegration: vi.fn().mockResolvedValue({ status: 'promoted' }), abandonWorktree: vi.fn(), cleanupWorktree: vi.fn() };
    await finalizeLoopWorktree({ state, status: 'completed-needs-review', worktreeSessionId: 'worktree', manager, store: { updateWorktreeLifecycle: vi.fn(), clearWorktreeInfo: vi.fn() } });
    expect(manager.integrateWorktree).toHaveBeenCalledTimes(hold ? 0 : 1);
    expect(manager.cleanupWorktree).toHaveBeenCalledWith('worktree', ...(hold ? [{ retainBranch: true }] : []));
    expect(manager.abandonWorktree).not.toHaveBeenCalled();
  });
});
