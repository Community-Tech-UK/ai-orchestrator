/**
 * P3 worktree boot-reconcile.
 *
 * Terminal loops reap their worktree on a fire-and-forget async path. A crash or
 * forced quit can cut that short, leaving an orphaned worktree on disk with the
 * `loop_runs.worktree_path` pointer still set. On the next boot we reconcile:
 *
 *  - If the worktree dir is gone, just clear the DB pointer.
 *  - If it exists and is dirty, harvest the uncommitted agent work to its branch
 *    before force-removing.
 *  - If the harvest commit fails, preserve the worktree and leave the DB
 *    pointer set so it reappears next boot for manual recovery.
 *  - Only clear the DB pointer after the directory is actually gone.
 */
import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getLogger } from '../logging/logger';
import { hermeticGitEnv } from '../workspace/git/git-env';

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

type WorktreeOrphan = ReturnType<WorktreeReconcileStore['getTerminalRunsWithWorktreePaths']>[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathCompareKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const parentKey = pathCompareKey(parent);
  const childKey = pathCompareKey(child);
  const relative = path.relative(parentKey, childKey);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

async function resolveWorktreeAdminRoot(orphan: WorktreeOrphan): Promise<string> {
  if (orphan.workspaceCwd) return orphan.workspaceCwd;

  const listed = await gitSafe(['worktree', 'list', '--porcelain'], orphan.worktreePath);
  const listedWorktrees = listed
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
  const adminRoot = listedWorktrees.find(
    (listedPath) => pathCompareKey(listedPath) !== pathCompareKey(orphan.worktreePath),
  ) ?? listedWorktrees[0];
  if (adminRoot) return adminRoot;

  return (await git(['rev-parse', '--show-toplevel'], orphan.worktreePath)).trim();
}

function isManagedLoopWorktree(root: string, worktreePath: string): boolean {
  const managedBase = path.resolve(root, '.worktrees');
  const resolvedWorktree = path.resolve(worktreePath);
  return pathCompareKey(managedBase) !== pathCompareKey(resolvedWorktree)
    && isInsideOrEqual(managedBase, resolvedWorktree);
}

async function removeOrphanWorktree(root: string, worktreePath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await gitSafe(['worktree', 'remove', '--force', worktreePath], root, 15_000);
    if (!(await pathExists(worktreePath))) return true;
    await sleep(100 * (attempt + 1));
  }

  if (isManagedLoopWorktree(root, worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await gitSafe(['worktree', 'prune'], root, 15_000);
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
  let reaped = 0;

  for (const orphan of orphaned) {
    if (!(await pathExists(orphan.worktreePath))) {
      store.clearWorktreeInfo(orphan.id);
      continue;
    }

    try {
      const root = await resolveWorktreeAdminRoot(orphan);
      const statusOut = await gitSafe(['status', '--porcelain'], orphan.worktreePath);
      let stillDirty = statusOut.trim().length > 0;

      if (stillDirty) {
        await gitSafe(['add', '-A'], orphan.worktreePath, 30_000);
        await gitSafe(
          ['commit', '--no-gpg-sign', '-m', 'Boot reconcile: captured uncommitted session output'],
          orphan.worktreePath,
          30_000,
        );
        const recheck = await gitSafe(['status', '--porcelain'], orphan.worktreePath, 10_000, 'X');
        stillDirty = recheck.trim().length > 0;
        if (stillDirty) {
          logger.warn('Loop store: boot reconcile skipping worktree removal - harvest commit failed, preserving for manual recovery', {
            loopRunId: orphan.id,
            worktreePath: orphan.worktreePath,
          });
          continue;
        }
      }

      const removed = await removeOrphanWorktree(root, orphan.worktreePath);
      if (!removed) {
        logger.warn('Loop store: boot reconcile skipping pointer clear because worktree removal failed', {
          loopRunId: orphan.id,
          worktreePath: orphan.worktreePath,
        });
        continue;
      }

      store.clearWorktreeInfo(orphan.id);
      reaped++;
    } catch (error) {
      logger.warn('Loop store: boot reconcile failed for orphaned worktree; preserving pointer', {
        loopRunId: orphan.id,
        worktreePath: orphan.worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (reaped > 0 || orphaned.length > 0) {
    logger.info(`Loop store: worktree reconcile - reaped ${reaped}/${orphaned.length} orphaned worktree(s)`);
  }
  return { reaped, total: orphaned.length };
}
