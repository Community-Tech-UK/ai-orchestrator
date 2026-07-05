/**
 * Static model capability catalog.
 *
 * A generated view of model capabilities, context windows, pricing, and
 * modalities for first-party providers Harness can route to.
 *
 * PROVIDER_MODEL_LIST is the canonical static source of selectable model IDs.
 * This file derives capability metadata from that list so the picker, settings
 * metadata, and capability catalog cannot drift independently.
 *
 * Runtime API discovery and models.dev overlays remain enrichment layers on top
 * of this offline fallback.
 *
 * Catalog version: 2026-07-03
 */

import {
  MODEL_PRICING,
  PROVIDER_MODEL_LIST,
  getProviderModelContextWindow,
  type ModelDisplayInfo,
} from '../types/provider.types';

export type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'embedding' | 'code';
export type ModelProvider =
  | 'anthropic'
  | 'google'
  | 'openai'
  | 'mistral'
  | 'meta'
  | 'cohere'
  | 'unknown';

export interface ModelCatalogEntry {
  /** Canonical model ID as used in API calls. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Provider of the model. */
  provider: ModelProvider;
  /** Maximum total context window in tokens (input + output). */
  contextWindow: number;
  /** Maximum output tokens in a single response. */
  maxOutputTokens: number;
  /** Pricing in USD per 1M tokens. */
  pricing?: {
    inputPer1mTokens: number;
    outputPer1mTokens: number;
    /** Prompt cache write per 1M tokens (Anthropic). */
    cachePer1mWrite?: number;
    /** Prompt cache read per 1M tokens (Anthropic). */
    cachePer1mRead?: number;
  };
  /** Input modalities supported. */
  inputModalities: ModelModality[];
  /** Output modalities supported. */
  outputModalities: ModelModality[];
  capabilities: {
    functionCalling: boolean;
    streaming: boolean;
    promptCaching: boolean;
    reasoning: boolean;
    /** Best for: routing hint for the delegation profiles system. */
    bestFor?: string[];
  };
  /** ISO 8601 date when this model entry was last verified. */
  lastVerified: string;
  /** Whether this model is still actively supported. */
  active: boolean;
}

const VERIFIED = '2026-07-03';

const CATALOG_PROVIDER_BY_STATIC_PROVIDER = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
} as const satisfies Record<string, ModelProvider>;

type StaticCatalogProvider = keyof typeof CATALOG_PROVIDER_BY_STATIC_PROVIDER;

const STATIC_CATALOG_PROVIDERS = Object.keys(
  CATALOG_PROVIDER_BY_STATIC_PROVIDER,
) as StaticCatalogProvider[];

/** Comprehensive static model catalog generated from PROVIDER_MODEL_LIST. */
export const MODEL_CATALOG: ModelCatalogEntry[] = STATIC_CATALOG_PROVIDERS.flatMap((provider) => {
  const catalogProvider = CATALOG_PROVIDER_BY_STATIC_PROVIDER[provider];
  return (PROVIDER_MODEL_LIST[provider] ?? []).map((model) =>
    buildCatalogEntry(provider, catalogProvider, model),
  );
});

function buildCatalogEntry(
  staticProvider: StaticCatalogProvider,
  provider: ModelProvider,
  model: ModelDisplayInfo,
): ModelCatalogEntry {
  const price = MODEL_PRICING[model.id];

  return {
    id: model.id,
    name: model.name,
    provider,
    contextWindow: inferContextWindow(staticProvider, model.id),
    maxOutputTokens: inferMaxOutputTokens(staticProvider, model.id),
    pricing: price
      ? {
          inputPer1mTokens: price.input,
          outputPer1mTokens: price.output,
          ...inferCachePricing(provider, price.input),
        }
      : undefined,
    inputModalities: inferInputModalities(provider),
    outputModalities: ['text'],
    capabilities: inferCapabilities(staticProvider, model),
    lastVerified: VERIFIED,
    active: true,
  };
}

function inferContextWindow(provider: StaticCatalogProvider, modelId: string): number {
  if (provider === 'claude') {
    return getProviderModelContextWindow(provider, modelId);
  }
  if (provider === 'gemini') {
    return 1_000_000;
  }
  return 200_000;
}

function inferMaxOutputTokens(provider: StaticCatalogProvider, modelId: string): number {
  const normalized = modelId.toLowerCase();

  if (provider === 'claude') {
    if (normalized.includes('fable') || normalized.includes('opus')) {
      return 128_000;
    }
    if (normalized.includes('sonnet')) {
      return 64_000;
    }
    return 8_000;
  }

  if (provider === 'gemini') {
    return normalized.includes('flash') ? 8_192 : 65_536;
  }

  return normalized.includes('mini') || normalized.includes('spark') ? 32_768 : 100_000;
}

function inferInputModalities(provider: ModelProvider): ModelModality[] {
  if (provider === 'google') {
    return ['text', 'image', 'audio', 'video'];
  }
  return ['text', 'image'];
}

function inferCapabilities(
  provider: StaticCatalogProvider,
  model: ModelDisplayInfo,
): ModelCatalogEntry['capabilities'] {
  return {
    functionCalling: true,
    streaming: true,
    promptCaching: provider !== 'gemini',
    reasoning: model.tier !== 'fast',
    bestFor: [
      model.tier,
      ...(model.family ? [model.family.toLowerCase()] : []),
    ],
  };
}

function inferCachePricing(
  provider: ModelProvider,
  inputPrice: number,
): Pick<NonNullable<ModelCatalogEntry['pricing']>, 'cachePer1mWrite' | 'cachePer1mRead'> {
  if (provider !== 'anthropic') {
    return {};
  }
  return {
    cachePer1mWrite: inputPrice * 1.25,
    cachePer1mRead: inputPrice * 0.1,
  };
}

/** Look up a catalog entry by model ID. Returns undefined if not found. */
export function getModelCatalogEntry(modelId: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId);
}

/** Get all active models for a given provider. */
export function getModelsForProvider(provider: ModelProvider): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider && m.active);
}

/** Get all active models that support a given input modality. */
export function getModelsWithInputModality(modality: ModelModality): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((m) => m.active && m.inputModalities.includes(modality));
}

/** Estimate prompt cost in USD. Returns undefined when pricing data is absent. */
export function estimatePromptCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const entry = getModelCatalogEntry(modelId);
  if (!entry?.pricing) return undefined;
  const { inputPer1mTokens, outputPer1mTokens } = entry.pricing;
  return (inputTokens / 1_000_000) * inputPer1mTokens +
         (outputTokens / 1_000_000) * outputPer1mTokens;
}
