import type { RepoJobRecord } from '../../shared/types/repo-job.types';
import type { BackgroundTaskManager } from '../tasks/background-task-manager';
import type { WorktreeManager } from '../workspace/git/worktree-manager';
import { verifyManagedWorktreeOwnership } from '../workspace/git/worktree-cleanup';

interface PausePorts {
  tasks: BackgroundTaskManager;
  persist(job: RepoJobRecord): void;
  terminate(id: string): Promise<void>;
}

/** Cancelling the task ends its monitor, while the owned folder is retained. */
export async function pauseRepoJobForRestart(job: RepoJobRecord, ports: PausePorts): Promise<void> {
  if (!job.globalPauseHeld && job.status !== 'running') return;
  job.globalPauseHeld = true;
  ports.persist(job);
  ports.tasks.cancel(job.id);
  const initialInstanceId = job.instanceId;
  if (initialInstanceId) await ports.terminate(initialInstanceId);
  const deadline = Date.now() + 35_000;
  while (ports.tasks.getTask(job.id)?.status === 'running') {
    if (Date.now() >= deadline) throw new Error('A repository job is still stopping. Wait before restarting Harness.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  // A creation already in flight may have published after the first snapshot.
  // Its task's best-effort cleanup is not proof that the provider actually stopped.
  if (job.instanceId && job.instanceId !== initialInstanceId) await ports.terminate(job.instanceId);
  job.status = 'queued';
  job.progressMessage = 'Paused for restart';
  ports.persist(job);
}

export function resumeRepoJobAfterRestart(job: RepoJobRecord, persist: (job: RepoJobRecord) => void, queue: (job: RepoJobRecord) => void): boolean {
  if (!job.globalPauseHeld) return false;
  job.globalPauseHeld = false;
  job.status = 'queued';
  job.instanceId = undefined;
  job.completedAt = undefined;
  job.error = undefined;
  persist(job);
  queue(job);
  return true;
}

export async function restoreRepoJobWorktree(job: RepoJobRecord, adopt: WorktreeManager['adoptWorktree']): Promise<void> {
  const worktree = job.resumeWorktree;
  if (!worktree) return;
  const owned = await verifyManagedWorktreeOwnership({ repoRoot: job.repoContext.gitRoot || job.workingDirectory,
    worktreePath: worktree.worktreePath, baseDir: '.worktrees', expectedBranch: worktree.branchName });
  if (!owned) throw new Error('The saved repository job folder is missing or its ownership changed.');
  const restored = await adopt(job.id, worktree.worktreePath, job.name, { baseBranch: worktree.baseBranch });
  job.resumeWorktree = { ...worktree, sessionId: restored.id };
}
