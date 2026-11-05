/** The writer clears ownership before appending this explicit discard receipt. */
export function planQueueIsDiscarded(item: { branchName: string | null; worktreePath: string | null; detail: string | null }): boolean {
  return !item.branchName && !item.worktreePath && /(?:^|\s)Discarded by [^\n]+\.$/.test(item.detail ?? '');
}
