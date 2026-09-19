/**
 * Plan Queue reconciler — compares what the queue's rows own against what is
 * actually on disk, and reports every mismatch.
 *
 * It NEVER deletes or commits anything. It looks only at `queue/*` branches and
 * worktrees under `.worktrees/queue/`; worktrees and branches created by loops,
 * campaigns or people are outside its scope by design.
 */

import { existsSync } from 'fs';
import * as path from 'path';
import type { PlanQueueAlert } from '@contracts/schemas/plan-queue';
import { gitExec } from '../workspace/git/git-exec';
import { isInsideOrEqual } from '../util/path-helpers';
import { pathCompareKey } from '../workspace/git/worktree-cleanup';
import { itemHoldsWorktree } from './plan-queue-state';
import { PLAN_QUEUE_BRANCH_PREFIX, PLAN_QUEUE_WORKTREE_BASE_DIR } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

interface ListedWorktree {
  path: string;
  branch?: string;
}

function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const listed: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      listed.push(current);
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return listed;
}

/**
 * Only `.worktrees/queue/...` belongs to the queue. The check is
 * boundary-aware: a plain prefix match would also claim a sibling like
 * `.worktrees/queue-manual-experiment`, which the queue never created.
 */
function isQueueWorktreePath(repoRoot: string, worktreePath: string): boolean {
  const queueDir = path.join(repoRoot, PLAN_QUEUE_WORKTREE_BASE_DIR, PLAN_QUEUE_BRANCH_PREFIX);
  return isInsideOrEqual(queueDir, worktreePath);
}

/**
 * @param workspaceRoots every workspace a run has used (any path inside the repo)
 * @param items every item that has ever owned a branch or worktree
 */
export async function reconcilePlanQueueWorktrees(
  workspaceRoots: readonly string[],
  items: readonly PlanQueueItem[],
): Promise<PlanQueueAlert[]> {
  const alerts: PlanQueueAlert[] = [];
  const ownedPaths = new Set(
    items.flatMap((i) => (i.worktreePath ? [pathCompareKey(i.worktreePath)] : [])),
  );
  const ownedBranches = new Set(items.flatMap((i) => (i.branchName ? [i.branchName] : [])));

  const repoRoots = new Set<string>();
  for (const workspace of workspaceRoots) {
    if (!existsSync(workspace)) continue;
    try {
      repoRoots.add(await gitExec(['rev-parse', '--show-toplevel'], workspace));
    } catch {
      // Not a git repository any more; nothing of ours can be in it.
    }
  }

  for (const repoRoot of repoRoots) {
    const listed = parseWorktreeList(await gitExec(['worktree', 'list', '--porcelain'], repoRoot));
    for (const worktree of listed) {
      if (!isQueueWorktreePath(repoRoot, worktree.path)) continue;
      if (!ownedPaths.has(pathCompareKey(worktree.path))) {
        alerts.push({ kind: 'unowned-worktree', path: worktree.path, branchName: worktree.branch });
      }
    }

    const branches = await gitExec(
      ['for-each-ref', '--format=%(refname:short)', `refs/heads/${PLAN_QUEUE_BRANCH_PREFIX}`],
      repoRoot,
    );
    for (const branchName of branches.split('\n').filter(Boolean)) {
      if (!ownedBranches.has(branchName)) {
        alerts.push({ kind: 'unowned-branch', branchName });
      }
    }
  }

  for (const item of items) {
    if (item.worktreePath && itemHoldsWorktree(item.state) && !existsSync(item.worktreePath)) {
      alerts.push({
        kind: 'missing-worktree',
        path: item.worktreePath,
        branchName: item.branchName ?? undefined,
        itemId: item.id,
      });
    }
  }

  return alerts;
}
