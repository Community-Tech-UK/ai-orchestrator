/**
 * Model Capabilities Registry
 *
 * Consolidates model metadata from limits.ts and provider.types.ts
 * into a single queryable registry with TTL caching and runtime enrichment.
 */

import { getLogger } from '../logging/logger';
import { CONTEXT_WINDOWS } from '../../shared/constants/limits';
import { MODEL_PRICING, CLAUDE_MODELS, GOOGLE_MODELS, OPENAI_MODELS } from '../../shared/types/provider.types';

// Re-export for consumers that need Codex context window from a single source.
export { CONTEXT_WINDOWS };

const logger = getLogger('ModelCapabilitiesRegistry');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  thinkingBudget?: number;
  supportsThinking: boolean;
  supportsBatching: boolean;
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}

const FALLBACK: ModelCapabilities = {
  contextWindow: CONTEXT_WINDOWS.CLAUDE_DEFAULT,
  maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
  supportsThinking: false,
  supportsBatching: false,
};

function pricingFor(modelKey: string): ModelCapabilities['pricing'] | undefined {
  const entry = MODEL_PRICING[modelKey];
  if (!entry) return undefined;
  return { inputPerMillion: entry.input, outputPerMillion: entry.output };
}

const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  'claude:opus': {
    contextWindow: CONTEXT_WINDOWS.CLAUDE_OPUS,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: true,
    supportsBatching: false,
    pricing: pricingFor(CLAUDE_MODELS.OPUS),
  },
  'claude:sonnet': {
    contextWindow: CONTEXT_WINDOWS.CLAUDE_SONNET,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: true,
    supportsBatching: false,
    pricing: pricingFor(CLAUDE_MODELS.SONNET),
  },
  'claude:haiku': {
    contextWindow: CONTEXT_WINDOWS.CLAUDE_HAIKU,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(CLAUDE_MODELS.HAIKU),
  },
  'openai:gpt-5.4': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(OPENAI_MODELS.GPT54),
  },
  'openai:gpt-5.4-mini': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(OPENAI_MODELS.GPT54_MINI),
  },
  'openai:o1': {
    contextWindow: CONTEXT_WINDOWS.O1,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
  },
  'google:gemini-flash': {
    contextWindow: CONTEXT_WINDOWS.GEMINI_FLASH,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(GOOGLE_MODELS.GEMINI_25_FLASH),
  },
  'google:gemini-pro': {
    contextWindow: CONTEXT_WINDOWS.GEMINI_PRO,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
    pricing: pricingFor(GOOGLE_MODELS.GEMINI_25_PRO),
  },
  // Codex / OpenAI models
  'codex:default': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
  },
  'codex:gpt-5.4': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
    pricing: pricingFor(OPENAI_MODELS.GPT54),
  },
  'codex:gpt-5.3-codex': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
    pricing: pricingFor(OPENAI_MODELS.GPT53_CODEX),
  },
  'codex:gpt-5.4-mini': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
    pricing: pricingFor(OPENAI_MODELS.GPT54_MINI),
  },
  'codex:gpt-5.3-codex-spark': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
    pricing: pricingFor(OPENAI_MODELS.GPT53_CODEX_SPARK),
  },
  'codex:gpt-5.2': {
    contextWindow: CONTEXT_WINDOWS.CODEX_DEFAULT,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
    pricing: pricingFor(OPENAI_MODELS.GPT52),
  },
};

interface CacheEntry {
  caps: ModelCapabilities;
  expiresAt: number;
}

export class ModelCapabilitiesRegistry {
  private static instance: ModelCapabilitiesRegistry | null = null;

  private capabilityCache = new Map<string, CacheEntry>();
  private enrichments = new Map<string, Partial<ModelCapabilities>>();

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  static getInstance(): ModelCapabilitiesRegistry {
    if (!ModelCapabilitiesRegistry.instance) {
      ModelCapabilitiesRegistry.instance = new ModelCapabilitiesRegistry();
    }
    return ModelCapabilitiesRegistry.instance;
  }

  static _resetForTesting(): void {
    ModelCapabilitiesRegistry.instance = null;
  }

  getCapabilities(provider: string, model: string): ModelCapabilities {
    const key = this.cacheKey(provider, model);

    const cached = this.capabilityCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.caps;
    }

    const caps = this.compute(provider, model);
    this.capabilityCache.set(key, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
    return caps;
  }

  enrichFromDiscovery(provider: string, model: string, discovered: Partial<ModelCapabilities>): void {
    const key = this.cacheKey(provider, model);
    const existing = this.enrichments.get(key) ?? {};
    this.enrichments.set(key, { ...existing, ...discovered });
    this.capabilityCache.delete(key);
    logger.debug('Enriched model capabilities from discovery', { provider, model, discovered });
  }

  private compute(provider: string, model: string): ModelCapabilities {
    const key = this.cacheKey(provider, model);
    const known = KNOWN_MODELS[key];
    const enrichment = this.enrichments.get(key);

    if (!known && !enrichment) {
      logger.debug('Unknown model — using fallback capabilities', { provider, model });
      return { ...FALLBACK };
    }

    return {
      ...(known ?? FALLBACK),
      ...(enrichment ?? {}),
    };
  }

  private cacheKey(provider: string, model: string): string {
    return `${provider.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
  }
}

export function getModelCapabilitiesRegistry(): ModelCapabilitiesRegistry {
  return ModelCapabilitiesRegistry.getInstance();
}
