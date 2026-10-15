import { subscribeCostAttribution } from '../core/system/cost-attribution';
import { resolveModelCallCost } from '../core/system/model-call-recorder';
import type { LoopSpendPortion, LoopUsageProvenance } from '../../shared/types/loop-spend.types';
export function collectInstanceSpend(instanceId: string, subscribe = subscribeCostAttribution): { stop(): { tokens: number; costUsd: number; exactUsd: number; records: number; unknownRecords: number; basis: LoopUsageProvenance; spendBreakdown: LoopSpendPortion[] } } {
  const totals = { tokens: 0, costUsd: 0, exactUsd: 0, records: 0, unknownRecords: 0 };
  const turns: (Omit<LoopSpendPortion, 'costCents'> & { costUsd: number })[] = [];
  let pricedRecords = 0;
  const unsubscribe = subscribe(record => {
    if (record.source !== 'instance-turn' || record.instanceId !== instanceId) return;
    const resolved = resolveModelCallCost(record.provider, record.model, record.usage);
    const count = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const tokens = count(record.usage?.inputTokens) + count(record.usage?.outputTokens);
    const basis = resolved.costSource === 'unknown' ? 'unknown' : resolved.costSource === 'priced' ? 'computed' : 'provider-reported';
    turns.push({ tokens, costUsd: resolved.costUsd ?? 0, basis, provider: record.provider, model: record.model });
    totals.tokens += tokens;
    totals.costUsd += resolved.costUsd ?? 0;
    if (resolved.costSource === 'provider' || resolved.costSource === 'free') totals.exactUsd += resolved.costUsd ?? 0;
    if (resolved.costSource === 'unknown') totals.unknownRecords += 1;
    if (resolved.costSource === 'priced') pricedRecords += 1;
    totals.records += 1;
  });
  return { stop: () => {
    unsubscribe();
    // Allocate rounding once across the session, keeping exact cents first.
    // A computed or unknown turn remains a row even if it receives zero cents.
    let cumulativeUsd = 0;
    let allocatedCents = 0;
    const spendBreakdown = [...turns.filter(turn => turn.basis === 'provider-reported'), ...turns.filter(turn => turn.basis !== 'provider-reported')].map(({ costUsd, ...turn }) => {
      cumulativeUsd += costUsd;
      const cents = Math.ceil(cumulativeUsd * 100);
      const costCents = cents - allocatedCents;
      allocatedCents = cents;
      return { ...turn, costCents };
    });
    return { ...totals, spendBreakdown, basis: totals.unknownRecords > 0 || totals.records === 0 ? 'unknown' : pricedRecords > 0 ? 'computed' : 'provider-reported' };
  } };
}
