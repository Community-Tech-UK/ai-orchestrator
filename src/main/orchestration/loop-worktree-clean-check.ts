import { gitExec } from '../workspace/git/git-exec';

/** Inspection failures must never permit destructive worktree cleanup. */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  try {
    return !(await gitExec(['status', '--porcelain'], worktreePath)).trim();
  } catch {
    return false;
  }
}
