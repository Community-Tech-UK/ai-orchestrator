import * as fs from 'fs/promises';
import * as path from 'path';
import { isInsideOrEqual, pathCompareKey, sleep } from '../../util/path-helpers';
import { gitExec, gitExecSafe } from './git-exec';
import { getGitWriteQueue } from './git-write-queue';

export { pathCompareKey } from '../../util/path-helpers';

function isManagedWorktreePath(repoRoot: string, baseDir: string, worktreePath: string): boolean {
  const resolvedBaseDir = path.resolve(repoRoot, baseDir);
  const resolvedWorktree = path.resolve(worktreePath);
  return pathCompareKey(resolvedBaseDir) !== pathCompareKey(resolvedWorktree)
    && isInsideOrEqual(resolvedBaseDir, resolvedWorktree);
}

async function worktreePathExists(worktreePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(worktreePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function removeManagedWorktreeDirectory(params: {
  repoRoot: string;
  worktreePath: string;
  baseDir: string;
}): Promise<void> {
  const { repoRoot, worktreePath, baseDir } = params;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await getGitWriteQueue().enqueue('worktree-remove', () =>
        gitExec(['worktree', 'remove', '--force', worktreePath], repoRoot)
      );
    } catch (error) {
      lastError = error;
    }
    if (!(await worktreePathExists(worktreePath))) return;
    await sleep(100 * (attempt + 1));
  }

  if (isManagedWorktreePath(repoRoot, baseDir, worktreePath)) {
    await getGitWriteQueue().enqueue('worktree-remove-fallback', async () => {
      await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await gitExecSafe(['worktree', 'prune'], repoRoot);
    });
    if (!(await worktreePathExists(worktreePath))) return;
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`Failed to remove worktree directory: ${worktreePath}`);
}
