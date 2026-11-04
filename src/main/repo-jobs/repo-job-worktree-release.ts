/**
 * Repository job folders are never removed when a job ends, and the in-memory
 * worktree session the in-app merge needs does not survive a restart. So at
 * startup, before any job can run, a finished job's folder can only be clutter:
 * its output is saved to the job's branch and the folder removed. The branch is
 * kept for review, a pull request or a manual merge.
 */
import { existsSync } from 'node:fs';
import type { RepoJobRecord } from '../../shared/types/repo-job.types';
import { createDefaultWorktreeConfig } from '../../shared/types/worktree.types';
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { removeManagedWorktreeDirectory, verifyManagedWorktreeOwnership } from '../workspace/git/worktree-cleanup';

const logger = getLogger('RepoJobWorktreeRelease');

/** Names of files Harness itself puts in a new folder: copies of the root's local env and override files, and the renderer port override. */
const PROVISIONED_PATTERNS = [...createDefaultWorktreeConfig().copyInclude, '.mise.local.toml'];

/**
 * The job's output, as git pathspecs: everything except untracked files with a
 * provisioned name. Those are Harness's copies, never the job's work, so they
 * are not saved to its branch (which may be pushed for a pull request) and go
 * with the folder. A tracked file with such a name is the project's own and is
 * saved like any other edit.
 */
async function outputPathspecs(worktreePath: string): Promise<string[]> {
  const copies = (await gitExec(['ls-files', '--others', '--exclude-standard', '-z', '--', ...PROVISIONED_PATTERNS], worktreePath))
    .split('\0').filter(Boolean);
  return ['--', '.', ...copies.map((file) => `:(exclude,literal)${file}`)];
}

/**
 * Stored jobs that are not running in this process, using the live record where
 * there is one. A stored job still marked running or queued but not live was
 * left that way by a crash or quit, so it counts as finished.
 */
export function finishedRepoJobs(stored: Iterable<RepoJobRecord>, live: ReadonlyMap<string, RepoJobRecord>): RepoJobRecord[] {
  return [...stored].map((job) => live.get(job.id) ?? job)
    .filter((job) => !live.has(job.id) || (job.status !== 'running' && job.status !== 'queued'));
}

/**
 * Startup only. Skips jobs held for the global pause (they resume in their
 * folder), folders whose ownership cannot be shown, and folders whose output
 * could not be saved. A job whose folder is already gone just forgets it.
 * Returns how many folders were removed.
 */
export async function releaseFinishedRepoJobFolders(
  jobs: Iterable<RepoJobRecord>,
  persist: (job: RepoJobRecord) => void,
): Promise<number> {
  let removed = 0;
  for (const job of jobs) {
    const worktree = job.resumeWorktree;
    if (!worktree || job.globalPauseHeld) continue;
    if (!existsSync(worktree.worktreePath)) {
      job.resumeWorktree = undefined;
      persist(job);
      continue;
    }
    const folder = {
      repoRoot: job.repoContext.gitRoot || job.workingDirectory,
      worktreePath: worktree.worktreePath,
      baseDir: '.worktrees',
      expectedBranch: worktree.branchName,
    };
    try {
      if (!(await verifyManagedWorktreeOwnership(folder))) continue;
      const saved = await getGitWriteQueue().enqueue('repo-job-folder-release', async () => {
        // Unresolved conflicts (a merge, cherry-pick, revert or stash pop left half-done) would be
        // committed with their markers; leave them for James.
        if (await gitExec(['ls-files', '--unmerged'], worktree.worktreePath)) return false;
        const output = await outputPathspecs(worktree.worktreePath);
        await gitExec(['add', '-A', ...output], worktree.worktreePath);
        if (await gitExec(['diff', '--cached', '--name-only'], worktree.worktreePath)) {
          await gitExec(['commit', '--no-verify', '--no-gpg-sign', '-m', `Repo job ${job.id}: output saved before its folder was removed`], worktree.worktreePath);
        }
        if (await gitExec(['status', '--porcelain', ...output], worktree.worktreePath)) return false;
        await removeManagedWorktreeDirectory({ ...folder, alreadyQueued: true });
        return true;
      });
      if (!saved) continue;
      job.resumeWorktree = undefined;
      persist(job);
      removed += 1;
    } catch (error) {
      logger.warn('Could not remove a finished repository job folder; it is kept', {
        jobId: job.id, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}
