import { sessionProjectPath } from '../../../../../src/shared/utils/worktree-project-path';

export const NO_WORKSPACE_KEY = '__no_workspace__';

/**
 * The Projects-list key for a session's folder. A session in a repository's
 * `.worktrees/` checkout (Plan Queue items, loops) belongs to that repository,
 * as on the desktop project rail. Routes may carry either form, so compare keys
 * only after passing both through this.
 */
export function projectKeyFor(workingDirectory: string | null | undefined): string {
  return sessionProjectPath(workingDirectory) || NO_WORKSPACE_KEY;
}
