import { subscribeCostAttribution } from '../core/system/cost-attribution';
import { resolveModelCallCost } from '../core/system/model-call-recorder';
import { getLogger } from '../logging/logger';
import type { PlanQueueStore } from './plan-queue-store';

const logger = getLogger('PlanQueueSpend');
export function attachPlanQueueSpendRecorder({ store, getInstanceMetadata, onRecorded, subscribe = subscribeCostAttribution }: {
  store: PlanQueueStore;
  getInstanceMetadata: (id: string) => Record<string, unknown> | undefined;
  subscribe?: typeof subscribeCostAttribution;
  onRecorded?: (runId: string, itemId?: string) => void;
}): () => void {
  let warned = false;
  return subscribe((record) => {
    if (record.source !== 'instance-turn' || !record.instanceId) return;
    try {
      const metadata = getInstanceMetadata(record.instanceId);
      const runId = metadata?.['planQueueRunId']; const itemId = metadata?.['planQueueItemId'];
      if (typeof runId !== 'string' || typeof metadata?.['planQueueRole'] !== 'string') return;
      const resolved = resolveModelCallCost(record.provider, record.model, record.usage);
      const tokens = (record.usage?.inputTokens ?? 0) + (record.usage?.outputTokens ?? 0);
      if (!tokens && resolved.costUsd === null) return;
      store.addSpend(typeof itemId === 'string' ? { itemId, runId } : { runId }, {
        tokens, costUsd: resolved.costUsd ?? 0,
        exactUsd: resolved.costSource === 'provider' || resolved.costSource === 'free' ? resolved.costUsd ?? 0 : 0,
      });
      onRecorded?.(runId, typeof itemId === 'string' ? itemId : undefined);
    } catch (error) {
      if (!warned) { warned = true; logger.warn('Could not record queue spend', { error: String(error) }); }
    }
  });
}
