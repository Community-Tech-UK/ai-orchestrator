import { computeProviderTokenCost } from '../../../shared/data/model-pricing';
import { normalizeUsage, type UsageLike } from '../../../shared/util/usage-normalization';
import type { ModelCallPurpose, ModelCallOutcome } from '../../../shared/types/cost-attribution.types';
import { recordCostAttribution, type CostAttributionRecord, type CostAttributionUsage } from './cost-attribution';

export type ModelCallCostSource = 'provider' | 'priced' | 'unknown' | 'free';

const FREE_PROVIDERS = new Set<string>(['copilot', 'cursor', 'ollama', 'lmstudio']);

/** Resolve only evidenced dollars: native billing, known free execution, or a priced token breakdown. */
export function resolveModelCallCost(provider: string | undefined, model: string | undefined, usage?: CostAttributionUsage): { costUsd: number | null; costSource: ModelCallCostSource } {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return { costUsd: usage.cost, costSource: 'provider' };
  if (FREE_PROVIDERS.has(provider?.toLowerCase() ?? '')) return { costUsd: 0, costSource: 'free' };
  const normalized = normalizeUsage(usage as UsageLike | undefined);
  if (!normalized || [normalized.input, normalized.output, normalized.cacheRead, normalized.cacheWrite, normalized.reasoning].every(value => value === undefined)) {
    return { costUsd: null, costSource: 'unknown' };
  }
  const priced = computeProviderTokenCost(provider, model, { inputTokens: normalized.input, outputTokens: normalized.output,
    cacheReadTokens: normalized.cacheRead, cacheWriteTokens: normalized.cacheWrite, reasoningTokens: normalized.reasoning });
  return typeof priced === 'number' && Number.isFinite(priced) && priced >= 0
    ? { costUsd: priced, costSource: 'priced' } : { costUsd: null, costSource: 'unknown' };
}

export interface ModelCallRecordInput extends Pick<CostAttributionRecord,
  'sessionId' | 'reasoningEffort' | 'rtkArm' | 'rtkTrialEligible' | 'rtkTrialKey' | 'rtkTrialSurface'> {
  /** Canonical values are {@link ModelCallPurpose}; open tags pass through. */
  purpose: ModelCallPurpose | (string & {});
  taskType?: string;
  provider?: string;
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

/** A multi-model aggregate cannot be charged to the requested model. */
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

/** Record one dispatched call without letting spend observation interrupt the caller. */
export function recordModelCall(input: ModelCallRecordInput): CostAttributionRecord | undefined {
  try {
    const reported = reportedModels(input.usage);
    const model = reported === undefined ? input.model : reported.length === 1 ? reported[0] : undefined;
    const rawUsage = input.usage as (UsageLike & { cost?: unknown; isEstimated?: unknown }) | undefined;
    const normalized = normalizeUsage(rawUsage);
    const usage: CostAttributionUsage = {};
    if (normalized?.input !== undefined) usage.inputTokens = normalized.input;
    if (normalized?.output !== undefined) usage.outputTokens = normalized.output;
    if (normalized?.cacheRead !== undefined) usage.cacheReadTokens = normalized.cacheRead;
    if (normalized?.cacheWrite !== undefined) usage.cacheWriteTokens = normalized.cacheWrite;
    if (normalized?.reasoning !== undefined) usage.reasoningTokens = normalized.reasoning;
    if (normalized?.total !== undefined) usage.totalTokens = normalized.total;

    const rawCost = rawUsage?.cost;
    const reportedCost = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : undefined;
    const free = input.costSource === 'free' || (reportedCost === undefined && FREE_PROVIDERS.has(input.provider?.toLowerCase() ?? ''));
    const failed = input.outcome !== undefined && input.outcome !== 'success';
    const isEstimated = input.isEstimated === true || rawUsage?.isEstimated === true;
    const priced = !failed && !free && reportedCost === undefined ? resolveModelCallCost(input.provider, model, usage) : undefined;
    const cost = free ? 0 : reportedCost ?? (failed ? undefined : priced?.costUsd ?? undefined);
    const costSource: ModelCallCostSource = cost === undefined ? 'unknown'
      : free ? 'free' : reportedCost !== undefined ? 'provider' : 'priced';
    if (cost !== undefined) usage.cost = cost;
    const record: CostAttributionRecord = {
      source: input.source ?? (input.purpose === 'helper' ? 'auxiliary' : 'one-shot'),
      purpose: input.purpose,
      taskType: input.taskType ?? input.purpose,
      provider: input.provider,
      model,
      correlationId: input.correlationId,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
      reasoningEffort: input.reasoningEffort,
      rtkArm: input.rtkArm,
      rtkTrialEligible: input.rtkTrialEligible,
      rtkTrialKey: input.rtkTrialKey,
      rtkTrialSurface: input.rtkTrialSurface,
      outcome: input.outcome ?? 'success',
      usage: Object.keys(usage).length ? usage : undefined,
      costSource,
      costUsd: cost ?? null,
      costKnown: cost !== undefined && (!isEstimated || reportedCost !== undefined || free),
      ...(isEstimated ? { isEstimated: true } : {}),
    };
    recordCostAttribution(record);
    return record;
  } catch {
    return undefined;
  }
}

export { purposeOf } from './cost-attribution';
