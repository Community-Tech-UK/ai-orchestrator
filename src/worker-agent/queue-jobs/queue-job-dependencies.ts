import { applyWorktreeIncludes, readWorktreeIncludes, worktreeHasDependencies } from '../../main/workspace/git/worktree-include';
import { provisionWorktreeDependencies } from '../../main/workspace/git/worktree-deps';
import { getLogger } from '../../main/logging/logger';

const logger = getLogger('QueueJobDependencies');

/**
 * Give an existing job folder its dependencies from the installed checkout, through the same helpers
 * `WorktreeManager.createWorktree` uses (its `installDependencies` is private): what `.worktreeinclude` lists is
 * linked first, and `provisionWorktreeDependencies` is the fallback. Never throws; a folder left without
 * dependencies is logged, as on the Mac.
 */
export async function provisionJobFolderDependencies(installedPath: string, folder: string): Promise<void> {
  try {
    const includes = await readWorktreeIncludes(installedPath);
    if (includes.length > 0) {
      const result = await applyWorktreeIncludes(installedPath, folder, includes);
      if (result.ok && await worktreeHasDependencies(folder)) return;
    }
    await provisionWorktreeDependencies(installedPath, folder);
  } catch (error) {
    logger.warn('Dependency setup for a queue job folder failed', { message: error instanceof Error ? error.message : String(error) });
  }
}
