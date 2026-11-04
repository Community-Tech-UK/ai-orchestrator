import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';

/** The writer clears ownership before appending this explicit discard receipt. */
export function planQueueIsDiscarded(item: PlanQueueItemDto): boolean {
  return !item.branchName && !item.worktreePath && /(?:^|\s)Discarded by [^\n]+\.$/.test(item.detail ?? '');
}
