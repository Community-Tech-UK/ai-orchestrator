import { computeProviderTokenCost } from '../../../shared/data/model-pricing';
import { normalizeUsage, type UsageLike } from '../../../shared/util/usage-normalization';
import { recordCostAttribution, type CostAttributionRecord, type CostAttributionUsage } from './cost-attribution';

export type ModelCallCostSource = 'provider' | 'priced' | 'unknown' | 'free';
export function resolveModelCallCost(provider: string | undefined, model: string | undefined, usage?: CostAttributionUsage): { costUsd: number | null; costSource: ModelCallCostSource } {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return { costUsd: usage.cost, costSource: 'provider' };
  if (['copilot', 'cursor', 'ollama', 'lmstudio'].includes(provider?.toLowerCase() ?? '')) return { costUsd: 0, costSource: 'free' };
  const normalized = normalizeUsage(usage as UsageLike | undefined);
  if (!normalized || !['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].some((key) => normalized[key as keyof typeof normalized] !== undefined)) return { costUsd: null, costSource: 'unknown' };
  const priced = computeProviderTokenCost(provider, model, { inputTokens: normalized.input, outputTokens: normalized.output, cacheReadTokens: normalized.cacheRead, cacheWriteTokens: normalized.cacheWrite, reasoningTokens: normalized.reasoning });
  return typeof priced === 'number' && Number.isFinite(priced) && priced >= 0
    ? { costUsd: priced, costSource: 'priced' } : { costUsd: null, costSource: 'unknown' };
}

export function recordModelCall(args: { purpose: string; taskType?: string; provider?: string; model?: string; usage?: CostAttributionUsage | UsageLike; correlationId?: string; instanceId?: string; outcome?: 'success' | 'error' | 'cancelled' }): void {
  try {
    const normalized = normalizeUsage(args.usage as UsageLike | undefined);
    const usage: CostAttributionUsage = { inputTokens: normalized?.input, outputTokens: normalized?.output, cacheReadTokens: normalized?.cacheRead, cacheWriteTokens: normalized?.cacheWrite, reasoningTokens: normalized?.reasoning, totalTokens: normalized?.total, cost: args.usage?.cost };
    const resolved = resolveModelCallCost(args.provider, args.model, usage);
    recordCostAttribution({ source: 'one-shot', ...args, taskType: args.taskType ?? args.purpose, usage, ...resolved, costKnown: resolved.costSource === 'provider' || resolved.costSource === 'free' });
  } catch { /* A spend observer cannot break a provider invocation. */ }
}

export function purposeOf(record: CostAttributionRecord): string {
  return record.purpose ?? record.taskType.split(':')[0];
}
