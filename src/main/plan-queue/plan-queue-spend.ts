import { randomUUID } from 'node:crypto';
import { subscribeCostAttribution } from '../core/system/cost-attribution';
import { resolveModelCallCost } from '../core/system/model-call-recorder';
import { getLogger } from '../logging/logger';
import type { PlanQueueStore } from './plan-queue-store';

const logger = getLogger('PlanQueueSpend');
export function attachPlanQueueSpendRecorder({ store, onRecorded, subscribe = subscribeCostAttribution }: {
  store: PlanQueueStore;
  subscribe?: typeof subscribeCostAttribution;
  onRecorded?: (runId: string, itemId?: string) => void;
}): () => void {
  let warned = false;
  return subscribe((record) => {
    if (record.source !== 'instance-turn' || !record.instanceId) return;
    try {
      if (!record.planQueue) return;
      const { runId, itemId, role, round } = record.planQueue;
      const resolved = resolveModelCallCost(record.provider, record.model, record.usage);
      const processed = (record.usage?.inputTokens ?? 0) + (record.usage?.cacheReadTokens ?? 0) + (record.usage?.cacheWriteTokens ?? 0);
      const output = record.usage?.outputTokens ?? 0;
      const tokens = processed + output;
      if (!tokens && resolved.costUsd === null) return;
      const costSource = record.costSource ?? resolved.costSource;
      const exact = costSource === 'free' || !record.isEstimated && record.provider !== 'codex' && costSource === 'provider';
      store.recordSpend({ id: randomUUID(), runId, itemId: typeof itemId === 'string' ? itemId : null,
        role, round, provider: record.provider ?? null,
        model: record.model ?? null, processed, output, costUsd: resolved.costUsd,
        costBasis: resolved.costUsd === null ? 'unknown' : exact ? 'exact' : 'estimated', createdAt: Date.now() });
      onRecorded?.(runId, typeof itemId === 'string' ? itemId : undefined);
    } catch (error) {
      if (!warned) { warned = true; logger.warn('Could not record queue spend', { error: String(error) }); }
    }
  });
}
