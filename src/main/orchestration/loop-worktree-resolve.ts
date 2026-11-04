import { stat } from 'node:fs/promises';
import type { LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import { gitExec } from '../workspace/git/git-exec';
import { removeOrphanWorktree } from './loop-worktree-reconcile';

export interface LoopWorktreeResolveStore {
  getWorktreeRecord(loopRunId: string): {
    worktreePath: string | null;
    workspaceCwd: string | null;
    lifecycle?: LoopWorktreeLifecycle;
  } | null;
  updateWorktreeLifecycle(loopRunId: string, lifecycle: LoopWorktreeLifecycle): void;
  clearWorktreeInfo(loopRunId: string): void;
}

export type ResolveBlockedWorktreeResult =
  | { status: 'resolved'; lifecycle: LoopWorktreeLifecycle }
  | { status: 'refused'; reason: string };

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Record that the operator dealt with a blocked managed worktree by hand, so
 * boot recovery stops retrying it (it skips `cleaned` rows). The branch is
 * never touched. A clean folder that is provably the run's is removed, since
 * boot recovery will no longer come back for it; one whose ownership cannot be
 * shown is left where it is. A worktree folder that still holds uncommitted
 * work is refused: resolving it would leave that work unmanaged and unseen.
 */
export async function resolveBlockedLoopWorktree(
  store: LoopWorktreeResolveStore,
  loopRunId: string,
  now = Date.now(),
): Promise<ResolveBlockedWorktreeResult> {
  const record = store.getWorktreeRecord(loopRunId);
  if (!record) return { status: 'refused', reason: 'Loop run not found' };
  const lifecycle = record.lifecycle;
  if (!lifecycle || lifecycle.phase !== 'blocked') {
    return { status: 'refused', reason: 'Only a blocked managed worktree can be marked resolved' };
  }

  if (record.worktreePath && await isDirectory(record.worktreePath)) {
    let dirty: string;
    try {
      dirty = await gitExec(['status', '--porcelain'], record.worktreePath);
    } catch {
      return { status: 'refused', reason: 'Unable to inspect the worktree folder' };
    }
    if (dirty) {
      return {
        status: 'refused',
        reason: 'The worktree folder still has uncommitted changes; commit or discard them first',
      };
    }
  }

  if (
    lifecycle.managedByAio === true && record.worktreePath && record.workspaceCwd && lifecycle.sessionBranch
    && await isDirectory(record.worktreePath)
    && await removeOrphanWorktree(record.workspaceCwd, record.worktreePath, lifecycle.sessionBranch)
  ) {
    store.clearWorktreeInfo(loopRunId);
  }

  const resolved: LoopWorktreeLifecycle = {
    ...lifecycle,
    phase: 'cleaned',
    resolvedByOperatorAt: now,
    updatedAt: now,
  };
  store.updateWorktreeLifecycle(loopRunId, resolved);
  return { status: 'resolved', lifecycle: resolved };
}
