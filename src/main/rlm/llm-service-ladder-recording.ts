import { recordModelCall } from '../core/system/model-call-recorder';
import type { CostAttributionUsage } from '../core/system/cost-attribution';
import { normalizeUsage, type UsageLike } from '../../shared/util/usage-normalization';
import { runCorrelatedPaidFrontierCall } from '../local-ai-guard/local-ai-cost-correlation';

export interface LlmLadderResult {
  text: string;
  provider: string;
  model?: string;
  usage?: CostAttributionUsage;
}

/** Chat Completions totals include cache/reasoning; our price buckets do not. */
export function normalizeOpenAiHelperUsage(usage: unknown): CostAttributionUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as UsageLike & {
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  const normalized = normalizeUsage(raw);
  if (!normalized) return undefined;
  const subset = (value: unknown, total: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && total !== undefined
      ? Math.min(value, total) : undefined;
  // Only native totals are inclusive. Canonical usage can pass through this
  // boundary again without subtracting its cache or reasoning a second time.
  if (raw.prompt_tokens !== undefined) {
    const cacheRead = subset(raw.prompt_tokens_details?.cached_tokens, normalized.input);
    const cacheWrite = subset(raw.prompt_tokens_details?.cache_write_tokens, normalized.input === undefined ? undefined : normalized.input - (cacheRead ?? 0));
    if (cacheRead !== undefined) normalized.cacheRead = cacheRead;
    if (cacheWrite !== undefined) normalized.cacheWrite = cacheWrite;
    if (normalized.input !== undefined) normalized.input -= (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (raw.completion_tokens !== undefined) {
    const reasoning = subset(raw.completion_tokens_details?.reasoning_tokens, normalized.output);
    if (reasoning !== undefined && normalized.output !== undefined) {
      normalized.reasoning = reasoning;
      normalized.output -= reasoning;
    }
  }
  return {
    inputTokens: normalized.input, outputTokens: normalized.output,
    cacheReadTokens: normalized.cacheRead, cacheWriteTokens: normalized.cacheWrite,
    reasoningTokens: normalized.reasoning, totalTokens: normalized.total,
  };
}

/** Persist a deterministic local winner, which has no provider dispatch. */
export function recordLadderResult(result: LlmLadderResult): string {
  recordModelCall({
    purpose: 'helper', taskType: 'local-ai-frontier-fallback',
    provider: result.provider, model: result.model, usage: result.usage,
    ...(['ollama', 'aio-basic-summary'].includes(result.provider) ? { costSource: 'free' as const } : {}),
  });
  return result.text;
}

/** One record per actual send; preflight and authorization failures stay out. */
export class LlmLadderCallRecorder {
  private dispatched = false;
  private settled = false;
  private usage: CostAttributionUsage = {};

  constructor(private readonly provider: string, private readonly model: string) {}

  dispatch<T>(send: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => { this.dispatched = true; return send(); };
    return this.provider === 'ollama' ? run() : runCorrelatedPaidFrontierCall(run);
  }

  observe(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const providerUsage = this.provider === 'openai' ? normalizeOpenAiHelperUsage(usage) : usage;
    const normalized = normalizeUsage(providerUsage as UsageLike | undefined);
    if (normalized?.input !== undefined) this.usage.inputTokens = normalized.input;
    if (normalized?.output !== undefined) this.usage.outputTokens = normalized.output;
    if (normalized?.cacheRead !== undefined) this.usage.cacheReadTokens = normalized.cacheRead;
    if (normalized?.cacheWrite !== undefined) this.usage.cacheWriteTokens = normalized.cacheWrite;
    if (normalized?.reasoning !== undefined) this.usage.reasoningTokens = normalized.reasoning;
    if (normalized?.total !== undefined) this.usage.totalTokens = normalized.total;
    const cost = (usage as { cost?: unknown }).cost;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) this.usage.cost = cost;
  }

  observeProviderEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const value = event as { usage?: unknown; message?: { usage?: unknown }; prompt_eval_count?: unknown; eval_count?: unknown };
    this.observe(value.message?.usage);
    this.observe(value.usage);
    if (this.provider === 'ollama') this.observe({ inputTokens: value.prompt_eval_count, outputTokens: value.eval_count });
  }

  succeed(usage?: unknown): void { this.observe(usage); this.finish('success'); }

  fail(error: unknown): void {
    const evidence = error as { name?: string; usage?: unknown; partialUsage?: unknown } | undefined;
    this.observe(evidence?.usage);
    this.observe(evidence?.partialUsage);
    this.finish(evidence?.name === 'AbortError' ? 'cancelled' : 'error');
  }

  /** Closing a generator before its terminal chunk is a cancelled call. */
  cancel(): void { this.finish('cancelled'); }

  private finish(outcome: 'success' | 'error' | 'cancelled'): void {
    if (!this.dispatched || this.settled) return;
    this.settled = true;
    const free = this.provider === 'ollama';
    recordModelCall({ purpose: 'helper', taskType: 'local-ai-frontier-fallback', provider: this.provider, model: this.model,
      outcome, usage: { ...this.usage, ...(free ? { cost: 0 } : {}) }, ...(free ? { costSource: 'free' as const } : {}) });
  }
}
