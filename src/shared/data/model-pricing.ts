/**
 * Single source of truth for converting token usage into a USD cost.
 *
 * Every provider adapter and the CostTracker route cost math through
 * {@link computeTokenCost} so pricing is consistent and never hand-fabricated
 * per provider (previously Claude used a 70/30 input/output guess and
 * Codex/Gemini used a flat $30/M blended rate).
 *
 * Rates in `MODEL_PRICING` are USD per 1M tokens. Cache reads bill at ~10% of
 * the input rate. Cache writes bill at the input rate (Anthropic-style prompt
 * caching) except on GPT-5.6 and later, where OpenAI charges 1.25x — see
 * {@link getCacheWriteMultiplier}. Reasoning/thinking tokens bill at the output
 * rate, so callers should fold them into `outputTokens`.
 *
 * Prefer a provider-reported dollar cost (e.g. Claude's `total_cost_usd`) when
 * one is available — it already accounts for the provider's exact cache
 * accounting. Use this helper only to price token counts when no authoritative
 * cost is reported.
 */
import { MODEL_PRICING } from '../types/provider.types';

export interface TokenCostInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * Fallback rate for models absent from `MODEL_PRICING`. Matches the
 * long-standing CostTracker default (Claude Sonnet-class pricing) so behaviour
 * is unchanged for unknown models.
 */
export const DEFAULT_MODEL_RATE: ModelRate = { input: 3, output: 15 };

/**
 * Runtime pricing overlay, populated from the live models.dev registry by the
 * main-process ModelsDevService. Consulted *before* the static `MODEL_PRICING`
 * snapshot, so new models and price changes need no code edit while the
 * committed snapshot remains the offline fallback. Keyed by model id.
 */
const overlayRates = new Map<string, ModelRate>();

/**
 * Merge live per-1M-token rates into the overlay (called by the models.dev
 * sync). Entries with non-finite rates are ignored so a malformed registry
 * response can never poison the pricing path.
 */
export function registerModelRates(rates: Record<string, ModelRate>): void {
  for (const [id, rate] of Object.entries(rates)) {
    if (id && rate && Number.isFinite(rate.input) && Number.isFinite(rate.output)) {
      overlayRates.set(id, { input: rate.input, output: rate.output });
    }
  }
}

/** Drop all overlay rates (used by tests and offline resets). */
export function clearModelRateOverlay(): void {
  overlayRates.clear();
}

/** Number of models currently priced by the live overlay. */
export function modelRateOverlaySize(): number {
  return overlayRates.size;
}

/** True when the live models.dev overlay has an explicit entry for this model. */
export function hasOverlayRate(model: string | undefined | null): boolean {
  return !!(model && overlayRates.has(model));
}

/** True when the overlay or `MODEL_PRICING` has an explicit entry for this model. */
export function hasModelRate(model: string | undefined | null): boolean {
  return !!(model && (overlayRates.has(model) || !!MODEL_PRICING[model]));
}

/**
 * Resolve the per-1M-token rate for a model. Prefers the live models.dev
 * overlay, then the committed `MODEL_PRICING` snapshot, then a default.
 */
export function getModelRate(model: string | undefined | null): ModelRate {
  if (model) {
    const overlay = overlayRates.get(model);
    if (overlay) return overlay;
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  }
  return DEFAULT_MODEL_RATE;
}

/**
 * OpenAI bills cache WRITES at 1.25x the uncached input rate for GPT-5.6 and
 * later ("For GPT-5.6 and later models, cache writes are billed at 1.25x the
 * model's uncached input rate, while cache reads continue to receive the 90%
 * cached-input discount" — openai.com/index/gpt-5-6). Everything older, and
 * Anthropic-style caching, writes at 1.0x.
 */
const OPENAI_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Cache-write multiplier applied on top of the input rate for `model`.
 *
 * Version-compared rather than enumerated so the next GPT release inherits the
 * correct billing instead of silently under-reporting until someone notices.
 */
export function getCacheWriteMultiplier(model: string | undefined | null): number {
  if (!model) return 1;
  const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(model.trim().toLowerCase());
  if (!match) return 1;

  const major = Number.parseInt(match[1], 10);
  const minor = match[2] ? Number.parseInt(match[2], 10) : 0;
  if (!Number.isFinite(major)) return 1;

  const isGpt56OrLater = major > 5 || (major === 5 && minor >= 6);
  return isGpt56OrLater ? OPENAI_CACHE_WRITE_MULTIPLIER : 1;
}

/**
 * Compute the USD cost for a single usage record using per-model
 * input/output/cache pricing. Negative or missing counts are clamped to 0.
 */
export function computeTokenCost(model: string | undefined | null, usage: TokenCostInput): number {
  const rate = getModelRate(model);
  const input = Math.max(0, usage.inputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const reasoning = Math.max(0, usage.reasoningTokens ?? 0);

  const cost =
    input * rate.input +
    output * rate.output +
    reasoning * rate.output +
    cacheRead * rate.input * 0.1 +
    cacheWrite * rate.input * getCacheWriteMultiplier(model);

  return cost / 1_000_000;
}
