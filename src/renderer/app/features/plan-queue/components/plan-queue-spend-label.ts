import { pluralise } from '../../../../../shared/utils/plan-queue-item-display';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
type Spend = NonNullable<PlanQueueRunDto['spend']>;
const dollars = (costUsd: number) => `$${costUsd.toFixed(2)}`;
const estimateLabel = (spend: Spend) => spend.costUsd > spend.exactUsd + 1e-9 ? ' (estimated)' : '';
export function queueItemSpendLabel(spend: Spend): string {
  const unpriced = spend.unpricedTokens ?? 0;
  const tokens = unpriced >= 1_000_000 ? `${(unpriced / 1_000_000).toFixed(1)}M` : unpriced.toLocaleString('en-GB');
  return unpriced ? `${spend.costUsd > 0 ? `${dollars(spend.costUsd)} known${estimateLabel(spend)} · ` : ''}${tokens} ${unpriced === 1 ? 'token' : 'tokens'} not priced` : `${dollars(spend.costUsd)}${estimateLabel(spend)}`;
}
export function queueRunSpendLabel(run: PlanQueueRunDto): string {
  if (!run.spend) return '';
  const landed = run.items.filter(item => item.state === 'landed');
  const fullyPriced = landed.filter(item => item.spend && !item.spend.unpricedTokens);
  const estimated = fullyPriced.some(item => estimateLabel(item.spend!));
  const each = fullyPriced.length ? `${dollars(fullyPriced.reduce((sum, item) => sum + item.spend!.costUsd, 0) / fullyPriced.length)}${estimated ? ' (estimated)' : ''} each among fully priced merges` : 'cost per merge not known';
  return `${queueItemSpendLabel(run.spend)} across ${pluralise(run.items.length, 'document')} · ${landed.length} merged (${each})`;
}
