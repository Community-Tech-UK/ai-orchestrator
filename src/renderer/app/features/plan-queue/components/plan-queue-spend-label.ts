import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
export function queueItemSpendLabel(costUsd: number): string {
  return Number.isFinite(costUsd) && costUsd >= 0 ? `$${costUsd.toFixed(2)}` : '-';
}
export function queueRunSpendLabel(run: PlanQueueRunDto): string {
  if (!run.spend) return '';
  const landed = run.items.filter(item => item.state === 'landed');
  const unmerged = run.items.filter(item => item.state !== 'landed').reduce((sum,item) => sum + (item.spend?.costUsd ?? 0), 0);
  const each = landed.length ? queueItemSpendLabel(landed.reduce((sum,item) => sum + (item.spend?.costUsd ?? 0),0) / landed.length) : '-';
  return `Spent ${queueItemSpendLabel(run.spend.costUsd)} across ${run.items.length} documents · ${landed.length} merged (${each} each) · ${queueItemSpendLabel(unmerged)} on the ones that did not merge`;
}
