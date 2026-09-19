import { stat } from 'node:fs/promises';
import type { LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import { gitExec } from '../workspace/git/git-exec';

export interface LoopWorktreeResolveStore {
  getWorktreeRecord(loopRunId: string): {
    worktreePath: string | null;
    lifecycle?: LoopWorktreeLifecycle;
  } | null;
  updateWorktreeLifecycle(loopRunId: string, lifecycle: LoopWorktreeLifecycle): void;
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
 * boot recovery stops retrying it (it skips `cleaned` rows). Nothing on disk or
 * in Git is changed. A worktree folder that still holds uncommitted work is
 * refused: resolving it would leave that work unmanaged and unseen.
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

  const resolved: LoopWorktreeLifecycle = {
    ...lifecycle,
    phase: 'cleaned',
    resolvedByOperatorAt: now,
    updatedAt: now,
  };
  store.updateWorktreeLifecycle(loopRunId, resolved);
  return { status: 'resolved', lifecycle: resolved };
}
