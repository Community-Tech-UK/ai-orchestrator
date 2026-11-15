/** A `.worktrees` directory segment, as created for Plan Queue items, loops and Harness-managed worktrees. */
const WORKTREES_SEGMENT = /[\\/]\.worktrees(?:[\\/]|$)/;
/** A Plan Queue item's worktree (`<repo>/.worktrees/queue/<item>`, see plan-queue-worktree.ts). */
const PLAN_QUEUE_WORKTREE = /[\\/]\.worktrees[\\/]queue[\\/]/;

/**
 * The project folder a session belongs to. A session working inside a
 * repository's `.worktrees/` checkout belongs to that repository's project;
 * without this, every Plan Queue item or loop worktree becomes a project of
 * its own. Shared by the desktop project rail and the phone's project list.
 */
export function sessionProjectPath(workingDirectory: string | null | undefined): string | null | undefined {
  const normalized = workingDirectory?.trim() ?? '';
  const match = WORKTREES_SEGMENT.exec(normalized);
  return match && match.index > 0 ? normalized.slice(0, match.index) : workingDirectory;
}

export function isWorktreePath(workingDirectory: string | null | undefined): boolean {
  return sessionProjectPath(workingDirectory) !== workingDirectory;
}

export function isPlanQueueWorktreePath(workingDirectory: string | null | undefined): boolean {
  return PLAN_QUEUE_WORKTREE.test(workingDirectory ?? '');
}
