/**
 * Static model capability catalog.
 *
 * A committed snapshot of model capabilities, context windows, pricing, and
 * modalities for all providers AI Orchestrator can route to. Sourced from
 * provider documentation and the models.dev dataset.
 *
 * This catalog is the *primary* source for the model picker and routing logic.
 * Runtime API discovery (model-discovery.ts) acts as an *enrichment layer*
 * on top — never as the primary source — so the picker is instant and fully
 * offline regardless of network availability.
 *
 * To update: regenerate by running `scripts/update-models-catalog.ts`
 * (or update manually when provider docs change).
 *
 * Catalog version: 2026-05-16
 */

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

const VERIFIED = '2026-05-16';

/** Comprehensive static model catalog. */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // ─────────────────────────────────────────────────
  // Anthropic — Claude 4.x family
  // ─────────────────────────────────────────────────
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: {
      inputPer1mTokens: 15.0,
      outputPer1mTokens: 75.0,
      cachePer1mWrite: 18.75,
      cachePer1mRead: 1.5,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: true,
      bestFor: ['complex reasoning', 'code generation', 'analysis', 'council'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    pricing: {
      inputPer1mTokens: 3.0,
      outputPer1mTokens: 15.0,
      cachePer1mWrite: 3.75,
      cachePer1mRead: 0.3,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: true,
      bestFor: ['balanced', 'code', 'orchestration', 'agentic'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    pricing: {
      inputPer1mTokens: 0.8,
      outputPer1mTokens: 4.0,
      cachePer1mWrite: 1.0,
      cachePer1mRead: 0.08,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: false,
      bestFor: ['fast', 'cheap', 'simple tasks', 'verification'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet (Oct 2024)',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    pricing: {
      inputPer1mTokens: 3.0,
      outputPer1mTokens: 15.0,
      cachePer1mWrite: 3.75,
      cachePer1mRead: 0.3,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: false,
      bestFor: ['code', 'analysis'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  // ─────────────────────────────────────────────────
  // Google — Gemini 2.x family
  // ─────────────────────────────────────────────────
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    pricing: {
      inputPer1mTokens: 1.25,  // ≤200k; $2.50 for >200k
      outputPer1mTokens: 10.0,
    },
    inputModalities: ['text', 'image', 'audio', 'video'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: false,
      reasoning: true,
      bestFor: ['long context', 'multimodal', 'reasoning'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    pricing: {
      inputPer1mTokens: 0.1,
      outputPer1mTokens: 0.4,
    },
    inputModalities: ['text', 'image', 'audio', 'video'],
    outputModalities: ['text', 'image', 'audio'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: false,
      reasoning: false,
      bestFor: ['fast', 'cheap', 'multimodal', 'agentic'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    pricing: {
      inputPer1mTokens: 0.075,
      outputPer1mTokens: 0.3,
    },
    inputModalities: ['text', 'image', 'audio', 'video'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: false,
      reasoning: false,
      bestFor: ['fast', 'cheap', 'long context'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  // ─────────────────────────────────────────────────
  // OpenAI — GPT-4o / o1 / o3 family
  // ─────────────────────────────────────────────────
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: {
      inputPer1mTokens: 2.5,
      outputPer1mTokens: 10.0,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: false,
      bestFor: ['balanced', 'multimodal', 'code'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: {
      inputPer1mTokens: 0.15,
      outputPer1mTokens: 0.6,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: false,
      bestFor: ['fast', 'cheap', 'simple'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'o3',
    name: 'OpenAI o3',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    pricing: {
      inputPer1mTokens: 10.0,
      outputPer1mTokens: 40.0,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: true,
      bestFor: ['deep reasoning', 'math', 'complex code', 'council'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'o4-mini',
    name: 'OpenAI o4-mini',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    pricing: {
      inputPer1mTokens: 1.1,
      outputPer1mTokens: 4.4,
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      reasoning: true,
      bestFor: ['fast reasoning', 'code', 'verification'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  // ─────────────────────────────────────────────────
  // Mistral
  // ─────────────────────────────────────────────────
  {
    id: 'mistral-large-latest',
    name: 'Mistral Large',
    provider: 'mistral',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    pricing: {
      inputPer1mTokens: 2.0,
      outputPer1mTokens: 6.0,
    },
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: false,
      reasoning: false,
      bestFor: ['multilingual', 'code', 'balanced'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
  {
    id: 'codestral-latest',
    name: 'Codestral',
    provider: 'mistral',
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    pricing: {
      inputPer1mTokens: 1.0,
      outputPer1mTokens: 3.0,
    },
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: {
      functionCalling: true,
      streaming: true,
      promptCaching: false,
      reasoning: false,
      bestFor: ['code generation', 'fill-in-middle', 'long files'],
    },
    lastVerified: VERIFIED,
    active: true,
  },
];

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
