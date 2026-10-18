import { computeProviderTokenCost } from '../../../shared/data/model-pricing';
import { normalizeUsage, type UsageLike } from '../../../shared/util/usage-normalization';
import type { ModelCallPurpose, ModelCallOutcome } from '../../../shared/types/cost-attribution.types';
import { recordCostAttribution, type CostAttributionRecord, type CostAttributionUsage } from './cost-attribution';

export type ModelCallCostSource = 'provider' | 'priced' | 'unknown' | 'free';

/** Providers that never bill; their calls resolve to a known $0 free cost. */
const FREE_PROVIDERS = ['copilot', 'cursor', 'ollama', 'lmstudio'];

/**
 * Resolve a call's dollar cost without recording: provider-reported dollars
 * (including zero) first, known free providers next, token pricing for a known
 * model, and `unknown` when no evidence can price the call.
 */
export function resolveModelCallCost(provider: string | undefined, model: string | undefined, usage?: CostAttributionUsage): { costUsd: number | null; costSource: ModelCallCostSource } {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return { costUsd: usage.cost, costSource: 'provider' };
  if (FREE_PROVIDERS.includes(provider?.toLowerCase() ?? '')) return { costUsd: 0, costSource: 'free' };
  const normalized = normalizeUsage(usage as UsageLike | undefined);
  if (!normalized || !['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].some((key) => normalized[key as keyof typeof normalized] !== undefined)) return { costUsd: null, costSource: 'unknown' };
  const priced = computeProviderTokenCost(provider, model, { inputTokens: normalized.input, outputTokens: normalized.output, cacheReadTokens: normalized.cacheRead, cacheWriteTokens: normalized.cacheWrite, reasoningTokens: normalized.reasoning });
  return typeof priced === 'number' && Number.isFinite(priced) && priced >= 0
    ? { costUsd: priced, costSource: 'priced' } : { costUsd: null, costSource: 'unknown' };
}

export interface ModelCallRecordInput {
  /** Canonical values are {@link ModelCallPurpose}; open tags pass through. */
  purpose: ModelCallPurpose | (string & {});
  taskType?: string;
  provider: string;
  model?: string;
  usage?: unknown;
  correlationId?: string;
  instanceId?: string;
  outcome?: ModelCallOutcome;
  /** Explicitly free execution paths; known free providers also resolve to $0. */
  costSource?: 'free';
  source?: CostAttributionRecord['source'];
  isEstimated?: boolean;
}

/** Undefined means no model evidence; an empty set means it cannot identify one model. */
function reportedModels(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const validModel = (model: unknown): model is string => typeof model === 'string' && model.trim().length > 0 && model.trim().length <= 512;
  if (usage['byModel'] !== undefined) {
    const entries = usage['byModel'];
    if (!Array.isArray(entries)) return [];
    const models: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validModel(entry.model)) return [];
      models.push(entry.model.trim());
    }
    return [...new Set(models)];
  }
  if (usage['providerModelUsage'] !== undefined) {
    const snapshot = usage['providerModelUsage'];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
    if (Object.values(snapshot).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) return [];
    const models = Object.keys(snapshot);
    return models.every(validModel) ? [...new Set(models.map(model => model.trim()))] : [];
  }
  return undefined;
}

/** Record one dispatched model call. Attribution must never break execution. */
export function recordModelCall(input: ModelCallRecordInput): CostAttributionRecord | undefined {
  try {
    const models = reportedModels(input.usage);
    const model = models === undefined ? input.model : models.length === 1 ? models[0] : undefined;
    const isEstimated = input.isEstimated === true || (input.usage as { isEstimated?: unknown } | undefined)?.isEstimated === true;
    const normalized = normalizeUsage(input.usage as UsageLike | undefined);
    const usage: CostAttributionUsage = {};
    if (normalized?.input !== undefined) usage.inputTokens = normalized.input;
    if (normalized?.output !== undefined) usage.outputTokens = normalized.output;
    if (normalized?.cacheRead !== undefined) usage.cacheReadTokens = normalized.cacheRead;
    if (normalized?.cacheWrite !== undefined) usage.cacheWriteTokens = normalized.cacheWrite;
    if (normalized?.reasoning !== undefined) usage.reasoningTokens = normalized.reasoning;
    if (normalized?.total !== undefined) usage.totalTokens = normalized.total;
    const rawCost = (input.usage as { cost?: unknown } | undefined)?.cost;
    const reportedCost = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : undefined;
    const failed = input.outcome !== undefined && input.outcome !== 'success';
    const explicitFree = input.costSource === 'free';
    const free = explicitFree || (reportedCost === undefined && FREE_PROVIDERS.includes(input.provider.toLowerCase()));
    const hasBreakdown = normalized && [normalized.input, normalized.output, normalized.cacheRead, normalized.cacheWrite, normalized.reasoning].some(value => value !== undefined);
    const priced = !failed && !free && hasBreakdown ? computeProviderTokenCost(input.provider, model, usage) : undefined;
    const cost = free ? 0 : failed ? reportedCost : reportedCost ?? priced;
    const costSource = cost === undefined ? 'unknown' : free ? 'free' : reportedCost !== undefined ? 'provider' : 'priced';
    if (cost !== undefined) usage.cost = cost;
    const record: CostAttributionRecord = {
      source: input.source ?? (input.purpose === 'helper' ? 'auxiliary' : 'one-shot'),
      purpose: input.purpose,
      taskType: input.taskType ?? input.purpose,
      provider: input.provider,
      model,
      correlationId: input.correlationId,
      instanceId: input.instanceId,
      outcome: input.outcome ?? 'success',
      usage: Object.keys(usage).length ? usage : undefined,
      costKnown: cost !== undefined && (!isEstimated || reportedCost !== undefined || free),
      costSource,
      costUsd: cost ?? null,
      ...(isEstimated ? { isEstimated: true } : {}),
    };
    recordCostAttribution(record);
    return record;
  } catch {
    return undefined;
  }
}
