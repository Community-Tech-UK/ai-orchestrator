/** Accept both separators: remote Windows paths can reach the coordinator. */
export function isTemporaryWorktreePath(workspacePath: string): boolean {
  return workspacePath.split(/[\\/]+/).includes('.worktrees');
}
