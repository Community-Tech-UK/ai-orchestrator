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

async function canonicalPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export async function verifyManagedWorktreeOwnership(params: {
  repoRoot: string;
  worktreePath: string;
  baseDir: string;
  expectedBranch: string;
}): Promise<boolean> {
  const { repoRoot, worktreePath, baseDir, expectedBranch } = params;
  const canonicalRoot = await canonicalPath(repoRoot);
  const canonicalWorktree = await canonicalPath(worktreePath);
  if (!isManagedWorktreePath(canonicalRoot, baseDir, canonicalWorktree)) {
    return false;
  }

  let listed: string;
  try {
    listed = await gitExec(['worktree', 'list', '--porcelain'], canonicalRoot);
  } catch {
    return false;
  }
  for (const record of listed.split(/\n\n+/)) {
    const lines = record.split('\n');
    const listedPath = lines
      .find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length)
      .trim();
    const listedBranch = lines
      .find((line) => line.startsWith('branch '))
      ?.slice('branch '.length)
      .trim();
    if (!listedPath || listedBranch !== `refs/heads/${expectedBranch}`) continue;
    if (pathCompareKey(await canonicalPath(listedPath)) === pathCompareKey(canonicalWorktree)) {
      return true;
    }
  }
  return false;
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
  expectedBranch: string;
}): Promise<void> {
  const { repoRoot, worktreePath, baseDir, expectedBranch } = params;
  if (!(await verifyManagedWorktreeOwnership(params))) {
    throw new Error('Managed worktree ownership could not be verified');
  }
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
      await gitExec(['worktree', 'prune'], repoRoot);
    });
    if (!(await worktreePathExists(worktreePath))) return;
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`Failed to remove worktree directory: ${worktreePath}`);
}

export async function deleteLocalBranchIfPresent(
  repoRoot: string,
  branchName: string,
  options:
    | { mergedIntoBranch: string; expectedTip: string; allowUnmerged?: false }
    | { allowUnmerged: true; expectedTip: string; mergedIntoBranch?: never },
): Promise<void> {
  await getGitWriteQueue().enqueue('worktree-branch-delete', async () => {
    const listed = await gitExec(['branch', '--list', branchName], repoRoot);
    if (!listed.trim()) return;
    if ('mergedIntoBranch' in options && options.mergedIntoBranch) {
      await gitExec(
        ['merge-base', '--is-ancestor', branchName, options.mergedIntoBranch],
        repoRoot,
      );
    }
    const branchTip = await gitExec(['rev-parse', `refs/heads/${branchName}`], repoRoot);
    if (branchTip !== options.expectedTip) {
      throw new Error(`Managed session branch ${branchName} changed identity`);
    }
    await gitExec(
      ['update-ref', '-d', `refs/heads/${branchName}`, branchTip],
      repoRoot,
    );
    const remaining = await gitExec(['branch', '--list', branchName], repoRoot);
    if (remaining.trim()) {
      throw new Error(`Managed session branch ${branchName} was not deleted`);
    }
  });
}
