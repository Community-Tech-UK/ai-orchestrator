import * as path from 'node:path';
import type { QueueWorktreeCreator } from './queue-job-env';

/**
 * Job folders are made by the SAME route the Mac uses: `WorktreeManager.createWorktree`, with the project's
 * installed checkout as its `repoRoot`, so `.worktreeinclude` entries are linked from that checkout and
 * `provisionWorktreeDependencies` is the fallback. The module is loaded on first use (like the adapter factory in
 * local-instance-manager.ts) and its closure has no top-level `electron` import, so it bundles into the worker.
 *
 * `createWorktree` always runs `git worktree add -b`, and its clean-up after a failure deletes the branch it was
 * asked to create; the caller only uses it for a branch that does not exist yet and reattaches otherwise.
 */
export const createQueueWorktree: QueueWorktreeCreator = async request => {
  const { WorktreeManager } = await import('../../main/workspace/git/worktree-manager');
  const manager = WorktreeManager.getInstance();
  manager.configure({
    // `createWorktree` puts a folder at repoRoot/baseDir/branch: <root>/queue-repos/<project>-installed/../../queue-worktrees.
    baseDir: path.join('..', '..', 'queue-worktrees'),
    // No local settings files are ever sent, so there is nothing to copy; make that true here too.
    copyInclude: [],
    installDeps: true,
    maxConcurrent: 0,
  });
  const session = await manager.createWorktree(request.jobId, `Plan Queue job ${request.jobId}`, {
    branchName: request.branch,
    baseBranch: request.commit,
    repoRoot: request.installedPath,
    countsTowardLimit: false,
  });
  return session.worktreePath;
};
