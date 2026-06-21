/**
 * P3 worktree boot-reconcile.
 *
 * Terminal loops reap their worktree on a fire-and-forget async path. A crash or
 * forced quit can cut that short, leaving an orphaned worktree on disk with the
 * `loop_runs.worktree_path` pointer still set. On the next boot we reconcile:
 *
 *  - If the worktree dir is gone, just clear the DB pointer.
 *  - If it exists and is dirty, harvest the uncommitted agent work to its branch
 *    BEFORE force-removing (Decision C: never discard unharvested work).
 *  - If the harvest commit fails (no identity, hook rejection, index lock), the
 *    tree stays dirty — we PRESERVE the worktree and leave the DB pointer set so
 *    it reappears next boot for manual recovery, rather than force-removing and
 *    permanently losing the work.
 *
 * Extracted from `initialization-steps.ts` so it can be unit-tested against a
 * real temp git repo without booting the whole app.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { getLogger } from '../logging/logger';

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
    try {
      // Only reap if the directory still exists; otherwise drop straight to the
      // catch-clause cleanup below (clears the stale DB pointer).
      await stat(orphan.worktreePath);

      // Linked worktrees know their root via `git rev-parse --show-toplevel`;
      // fall back to the persisted workspaceCwd.
      const { stdout: repoRoot } = await execFileAsync(
        'git', ['rev-parse', '--show-toplevel'],
        { cwd: orphan.worktreePath, encoding: 'utf-8', timeout: 10_000 },
      ).catch(() => ({ stdout: '' }));
      const root = repoRoot.toString().trim() || orphan.workspaceCwd || '';

      // Harvest uncommitted agent work before reap.
      const { stdout: statusOut } = await execFileAsync(
        'git', ['status', '--porcelain'],
        { cwd: orphan.worktreePath, encoding: 'utf-8', timeout: 10_000 },
      ).catch(() => ({ stdout: '' }));
      let stillDirty = statusOut.toString().trim().length > 0;

      if (stillDirty) {
        await execFileAsync(
          'git', ['add', '-A'],
          { cwd: orphan.worktreePath, encoding: 'utf-8', timeout: 30_000 },
        ).catch(() => { /* best-effort */ });
        await execFileAsync(
          'git', ['commit', '--no-gpg-sign', '-m', 'Boot reconcile: captured uncommitted session output'],
          { cwd: orphan.worktreePath, encoding: 'utf-8', timeout: 30_000 },
        ).catch(() => { /* best-effort — empty commit is fine, git exits non-zero */ });
        // Re-check: if still dirty after commit, do NOT force-remove. The commit
        // may have failed (missing git identity, hook error, index lock).
        // Removing now would permanently discard uncommitted agent output.
        const { stdout: recheck } = await execFileAsync(
          'git', ['status', '--porcelain'],
          { cwd: orphan.worktreePath, encoding: 'utf-8', timeout: 10_000 },
        ).catch(() => ({ stdout: 'X' })); // treat error as dirty
        stillDirty = recheck.toString().trim().length > 0;
        if (stillDirty) {
          logger.warn('Loop store: boot reconcile skipping worktree removal — harvest commit failed, preserving for manual recovery', {
            loopRunId: orphan.id,
            worktreePath: orphan.worktreePath,
          });
          // Do NOT clear the DB pointer — leave it visible on next boot.
          continue;
        }
      }

      if (root) {
        await execFileAsync(
          'git', ['worktree', 'remove', '--force', orphan.worktreePath],
          { cwd: root, encoding: 'utf-8', timeout: 15_000 },
        ).catch(() => { /* best-effort */ });
      }
      store.clearWorktreeInfo(orphan.id);
      reaped++;
    } catch {
      // worktree path already gone (or unstattable) — just clear the DB column.
      store.clearWorktreeInfo(orphan.id);
    }
  }

  if (reaped > 0 || orphaned.length > 0) {
    logger.info(`Loop store: worktree reconcile — reaped ${reaped}/${orphaned.length} orphaned worktree(s)`);
  }
  return { reaped, total: orphaned.length };
}
