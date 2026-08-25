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
import { MODEL_PRICING, PROVIDER_MODEL_LIST, RETIRED_PROVIDER_MODELS } from '../types/provider.types';

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
const providerOverlayRates = new Map<string, ModelRate>();

export interface ProviderModelRate {
  provider: string;
  id: string;
  rate: ModelRate;
}

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

/** Register live rates without losing the provider namespace. */
export function registerProviderModelRates(entries: Iterable<ProviderModelRate>): void {
  for (const entry of entries) {
    const provider = normalizePricingProvider(entry.provider);
    const id = entry.id.trim();
    if (provider && id && Number.isFinite(entry.rate.input) && Number.isFinite(entry.rate.output)) {
      providerOverlayRates.set(`${provider}:${id}`, {
        input: entry.rate.input,
        output: entry.rate.output,
      });
    }
  }
}

/** Drop all overlay rates (used by tests and offline resets). */
export function clearModelRateOverlay(): void {
  overlayRates.clear();
  providerOverlayRates.clear();
}

/** Number of models currently priced by the live overlay. */
export function modelRateOverlaySize(): number {
  return Math.max(overlayRates.size, providerOverlayRates.size);
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
 * Providers whose raw model ids the flat, non-namespaced `MODEL_PRICING`
 * snapshot actually prices — i.e. the primary vendors that own that raw-id
 * space. Deliberately an allowlist, not a denylist: a *reseller/proxy*
 * provider (`copilot`, `cursor`, ...) can and does reuse the exact same raw
 * id string as a primary vendor for a pass-through model (verified:
 * `COPILOT_MODELS.CLAUDE_OPUS_5 === CLAUDE_PINNED_MODELS.OPUS_5 ===
 * 'claude-opus-5'`; `COPILOT_MODELS.GPT53_CODEX === OPENAI_MODELS.GPT53_CODEX`;
 * `COPILOT_MODELS.GEMINI_3_1_PRO` literally aliases `GOOGLE_MODELS.GEMINI_3_1_PRO`;
 * Cursor's curated list reuses `'gpt-5.3-codex'` too). Falling through to the
 * flat table for one of those would silently price it at the *primary
 * vendor's direct per-token API rate* — wrong not just in magnitude but in
 * billing model, since Copilot and Cursor here are subscription seats, not
 * metered API access (LT-190 completion-gate finding, 2026-08-18). A new
 * provider is unpriced by default until deliberately added here; the
 * provider-namespaced live overlay (`providerOverlayRates`, checked first)
 * is unaffected and remains the correct way to give a reseller its own real
 * rate if one is ever known.
 */
const STATIC_TABLE_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'grok']);

/** Resolve pricing only when the model belongs to the supplied provider namespace. */
export function getProviderModelRate(
  provider: string | undefined | null,
  model: string | undefined | null,
): ModelRate | undefined {
  const normalizedProvider = normalizePricingProvider(provider);
  const normalizedModel = model?.trim();
  if (!normalizedProvider || !normalizedModel) return undefined;
  const overlay = providerOverlayRates.get(`${normalizedProvider}:${normalizedModel}`);
  if (overlay) return overlay;
  if (!STATIC_TABLE_PROVIDERS.has(normalizedProvider)) return undefined;
  // Retired ids stay priceable: they are gone from the offer list but still
  // appear in historical sessions and stale persisted defaults, where an
  // undefined rate is accumulated downstream as $0.
  const offered = (PROVIDER_MODEL_LIST[normalizedProvider] ?? []).some(
    (entry) => entry.id === normalizedModel,
  );
  const retired = (RETIRED_PROVIDER_MODELS[normalizedProvider] ?? []).includes(normalizedModel);
  if (!offered && !retired) {
    return undefined;
  }
  return MODEL_PRICING[normalizedModel];
}

export function computeProviderTokenCost(
  provider: string | undefined | null,
  model: string | undefined | null,
  usage: TokenCostInput,
): number | undefined {
  const rate = getProviderModelRate(provider, model);
  if (!rate || !model) return undefined;
  return computeCost(rate, model, usage);
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
  return computeCost(getModelRate(model), model, usage);
}

function computeCost(
  rate: ModelRate,
  model: string | undefined | null,
  usage: TokenCostInput,
): number {
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

/**
 * `PROVIDER_MODEL_LIST`'s own keys (the CLI-facing provider ids: `claude`,
 * `codex`, `gemini`, `copilot`, ...). Callers that already have one of these
 * (e.g. `settings.defaultCli`) must pass through unchanged rather than fail
 * to normalize — see LT-190.
 */
const CLI_PROVIDER_KEYS = new Set(Object.keys(PROVIDER_MODEL_LIST));

function normalizePricingProvider(provider: string | undefined | null): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (CLI_PROVIDER_KEYS.has(normalized)) return normalized;
  switch (normalized) {
    case 'anthropic': return 'claude';
    case 'openai': return 'codex';
    case 'google': return 'gemini';
    // models.dev namespaces xAI as `xai`; the CLI-facing provider id is `grok`.
    // Without this the whole xAI namespace was discarded from the live overlay,
    // so Grok sessions could only ever be priced from the static table.
    case 'xai': return 'grok';
    default: return undefined;
  }
}
