/**
 * P3 worktree boot-reconcile.
 *
 * Lifecycle-null rows come from versions before AIO persisted an explicit
 * ownership marker. Their paths may have been supplied by callers, so startup
 * recovery must preserve any directory that still exists:
 *
 *  - If the worktree dir is gone, just clear the DB pointer.
 *  - If it exists, retain both the pointer and checkout for manual recovery.
 *  - Destructive recovery is reserved for lifecycle rows with durable AIO
 *    ownership metadata.
 */
import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getLogger } from '../logging/logger';
import { isInsideOrEqual, pathCompareKey, sleep } from '../util/path-helpers';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { verifyManagedWorktreeOwnership } from '../workspace/git/worktree-cleanup';

const execFileAsync = promisify(execFile);
const logger = getLogger('LoopWorktreeReconcile');

/** Minimal slice of `LoopStore` the reconcile needs. */
export interface WorktreeReconcileStore {
  getTerminalRunsWithWorktreePaths(): {
    id: string;
    worktreePath: string;
    branchName: string | null;
    workspaceCwd: string | null;
    status: string;
  }[];
  clearWorktreeInfo(loopRunId: string): void;
}

export interface WorktreeReconcileResult {
  /** Worktrees successfully removed (their DB pointer cleared). */
  reaped: number;
  /** Total orphan candidates examined. */
  total: number;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function git(args: string[], cwd: string, timeout = 10_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: hermeticGitEnv(),
    encoding: 'utf-8',
    timeout,
  });
  return stdout.toString();
}

async function gitSafe(args: string[], cwd: string, timeout = 10_000, fallback = ''): Promise<string> {
  try {
    return await git(args, cwd, timeout);
  } catch {
    return fallback;
  }
}

function isManagedLoopWorktree(root: string, worktreePath: string): boolean {
  const managedBase = path.resolve(root, '.worktrees');
  const resolvedWorktree = path.resolve(worktreePath);
  return pathCompareKey(managedBase) !== pathCompareKey(resolvedWorktree)
    && isInsideOrEqual(managedBase, resolvedWorktree);
}

export async function removeOrphanWorktree(
  root: string,
  worktreePath: string,
  expectedBranch: string | null,
): Promise<boolean> {
  if (
    !expectedBranch
    || !(await verifyManagedWorktreeOwnership({
      repoRoot: root,
      worktreePath,
      baseDir: '.worktrees',
      expectedBranch,
    }))
  ) {
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await getGitWriteQueue().enqueue('orphan-worktree-remove', () =>
      gitSafe(['worktree', 'remove', '--force', worktreePath], root, 15_000)
    );
    if (!(await pathExists(worktreePath))) return true;
    await sleep(100 * (attempt + 1));
  }

  if (isManagedLoopWorktree(root, worktreePath)) {
    await getGitWriteQueue().enqueue('orphan-worktree-remove-fallback', async () => {
      await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await git(['worktree', 'prune'], root, 15_000);
    });
    return !(await pathExists(worktreePath));
  }

  return false;
}

/**
 * Reconcile orphaned worktrees recorded by terminal loop runs. Best-effort: a
 * failure on one orphan never aborts the others. Returns counts for logging.
 */
export async function reconcileOrphanedWorktrees(
  store: WorktreeReconcileStore,
): Promise<WorktreeReconcileResult> {
  const orphaned = store.getTerminalRunsWithWorktreePaths();
  const reaped = 0;

  for (const orphan of orphaned) {
    if (!(await pathExists(orphan.worktreePath))) {
      store.clearWorktreeInfo(orphan.id);
      continue;
    }

    logger.warn('Loop store: preserving ambiguous legacy worktree for manual recovery', {
      loopRunId: orphan.id,
      worktreePath: orphan.worktreePath,
    });
  }

  if (reaped > 0 || orphaned.length > 0) {
    logger.info(`Loop store: worktree reconcile - reaped ${reaped}/${orphaned.length} orphaned worktree(s)`);
  }
  return { reaped, total: orphaned.length };
}
