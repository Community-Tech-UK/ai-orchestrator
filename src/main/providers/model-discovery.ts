/**
 * Model Discovery Service - Dynamically discover available models from providers
 *
 * Features:
 * - Fetch available models from provider APIs
 * - Cache model information with TTL
 * - Track model capabilities and pricing
 * - Support multiple providers
 */

import * as https from 'https';
import * as http from 'http';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('ModelDiscovery');

export interface DiscoveredModel {
  id: string;
  name: string;
  displayName?: string;
  provider: string;
  description?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  pricing?: ModelPricing;
  isAvailable: boolean;
  lastChecked: number;
}

export interface ModelCapabilities {
  vision?: boolean;
  functionCalling?: boolean;
  streaming?: boolean;
  json?: boolean;
  systemMessage?: boolean;
  maxTemperature?: number;
}

export interface ModelPricing {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  cachePer1kTokens?: number;
  currency: string;
}

export interface ProviderModelConfig {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  organizationId?: string;
}

interface CacheEntry {
  models: DiscoveredModel[];
  timestamp: number;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class ModelDiscoveryService {
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtl: number;

  constructor(cacheTtlMs = DEFAULT_CACHE_TTL_MS) {
    this.cacheTtl = cacheTtlMs;
  }

  /**
   * Discover available models for a provider
   */
  async discoverModels(config: ProviderModelConfig): Promise<DiscoveredModel[]> {
    const cacheKey = `${config.type}:${config.baseUrl || 'default'}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.models;
    }

    // Fetch from provider
    let models: DiscoveredModel[] = [];

    try {
      switch (config.type) {
        case 'anthropic':
          models = await this.discoverAnthropicModels(config);
          break;
        case 'openai':
          models = await this.discoverOpenAIModels(config);
          break;
        case 'google':
          models = await this.discoverGoogleModels(config);
          break;
        case 'mistral':
          models = await this.discoverMistralModels(config);
          break;
        case 'groq':
          models = await this.discoverGroqModels(config);
          break;
        case 'ollama':
          models = await this.discoverOllamaModels(config);
          break;
        default:
          logger.warn('Unknown provider type', { providerType: config.type });
      }
    } catch (error) {
      logger.error('Failed to discover models', error instanceof Error ? error : undefined, { providerType: config.type });
      // Return cached data if available, even if expired
      if (cached) {
        return cached.models;
      }
    }

    // Update cache
    if (models.length > 0) {
      this.cache.set(cacheKey, {
        models,
        timestamp: Date.now(),
        expiresAt: Date.now() + this.cacheTtl,
      });
    }

    return models;
  }

  /**
   * Clear cache for a provider or all providers
   */
  clearCache(providerType?: string): void {
    if (providerType) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${providerType}:`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  /**
   * Check if a specific model is available
   */
  async isModelAvailable(
    config: ProviderModelConfig,
    modelId: string
  ): Promise<boolean> {
    const models = await this.discoverModels(config);
    return models.some((m) => m.id === modelId && m.isAvailable);
  }

  /**
   * Get model details
   */
  async getModelDetails(
    config: ProviderModelConfig,
    modelId: string
  ): Promise<DiscoveredModel | undefined> {
    const models = await this.discoverModels(config);
    return models.find((m) => m.id === modelId);
  }

  // ============================================
  // Provider-specific discovery methods
  // ============================================

  /**
   * Discover Anthropic models
   * Anthropic doesn't have a models list API, so we use known models
   */
  private async discoverAnthropicModels(
    config: ProviderModelConfig
  ): Promise<DiscoveredModel[]> {
    // Anthropic models are relatively static, use known list
    const knownModels: DiscoveredModel[] = [
      {
        id: CLAUDE_MODELS.OPUS,
        name: 'Claude Opus 4.5',
        displayName: 'Claude Opus 4.5',
        provider: 'anthropic',
        description: 'Most capable model for complex tasks',
        contextLength: 1000000,
        maxOutputTokens: 32000,
        capabilities: {
          vision: true,
          functionCalling: true,
          streaming: true,
          json: true,
          systemMessage: true,
        },
        pricing: {
          inputPer1kTokens: 0.005,
          outputPer1kTokens: 0.025,
          cachePer1kTokens: 0.00625,
          currency: 'USD',
        },
        isAvailable: true,
        lastChecked: Date.now(),
      },
      {
        id: CLAUDE_MODELS.SONNET,
        name: 'Claude Sonnet 4.5',
        displayName: 'Claude Sonnet 4.5',
        provider: 'anthropic',
        description: 'Balanced performance and cost',
        contextLength: 1000000,
        maxOutputTokens: 64000,
        capabilities: {
          vision: true,
          functionCalling: true,
          streaming: true,
          json: true,
          systemMessage: true,
        },
        pricing: {
          inputPer1kTokens: 0.003,
          outputPer1kTokens: 0.015,
          cachePer1kTokens: 0.00375,
          currency: 'USD',
        },
        isAvailable: true,
        lastChecked: Date.now(),
      },
      {
        id: CLAUDE_MODELS.HAIKU,
        name: 'Claude Haiku 4.5',
        displayName: 'Claude Haiku 4.5',
        provider: 'anthropic',
        description: 'Fast and cost-effective',
        contextLength: 1000000,
        maxOutputTokens: 8192,
        capabilities: {
          vision: true,
          functionCalling: true,
          streaming: true,
          json: true,
          systemMessage: true,
        },
        pricing: {
          inputPer1kTokens: 0.001,
          outputPer1kTokens: 0.005,
          cachePer1kTokens: 0.00125,
          currency: 'USD',
        },
        isAvailable: true,
        lastChecked: Date.now(),
      },
    ];

    // Verify API key is valid by making a test request if available
    if (config.apiKey) {
      try {
        const isValid = await this.verifyAnthropicApiKey(config.apiKey);
        return knownModels.map((m) => ({ ...m, isAvailable: isValid }));
      } catch {
        return knownModels.map((m) => ({ ...m, isAvailable: false }));
      }
    }

    return knownModels;
  }

  /**
   * Verify Anthropic API key
   */
  private async verifyAnthropicApiKey(apiKey: string): Promise<boolean> {
    // Make a minimal request to verify the key
    try {
      await this.httpRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODELS.HAIKU,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return true;
    } catch (error) {
      const err = error as { statusCode?: number };
      // 401 means invalid key, other errors mean key might be valid
      return err.statusCode !== 401;
    }
  }

  /**
   * Discover OpenAI models
   */
  private async discoverOpenAIModels(
    config: ProviderModelConfig
  ): Promise<DiscoveredModel[]> {
    if (!config.apiKey) {
      return [];
    }

    try {
      const baseUrl = config.baseUrl || 'api.openai.com';
      const response = await this.httpRequest({
        hostname: baseUrl,
        path: '/v1/models',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          ...(config.organizationId && { 'OpenAI-Organization': config.organizationId }),
        },
      });

      const data = JSON.parse(response) as { data: Array<{ id: string; owned_by: string }> };
      const models: DiscoveredModel[] = [];

      for (const model of data.data) {
        // Filter to chat models (gpt-4/5, o1/o3/o4, codex)
        if (!model.id.includes('gpt') && !model.id.includes('o1') && !model.id.includes('o3') && !model.id.includes('o4') && !model.id.includes('codex')) {
          continue;
        }

        const pricing = this.getOpenAIPricing(model.id);
        models.push({
          id: model.id,
          name: model.id,
          displayName: this.formatModelName(model.id),
          provider: 'openai',
          capabilities: this.getOpenAICapabilities(model.id),
          pricing,
          isAvailable: true,
          lastChecked: Date.now(),
        });
      }

      return models;
    } catch (error) {
      logger.error('Failed to discover OpenAI models', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get OpenAI model capabilities
   */
  private getOpenAICapabilities(modelId: string): ModelCapabilities {
    const caps: ModelCapabilities = {
      functionCalling: true,
      streaming: true,
      json: true,
      systemMessage: true,
    };

    // Vision models (GPT-5 family, GPT-4o, GPT-4-turbo all support vision)
    if (modelId.includes('gpt-5') || modelId.includes('gpt-4o') || modelId.includes('gpt-4-turbo') || modelId.includes('vision')) {
      caps.vision = true;
    }

    return caps;
  }

  /**
   * Get OpenAI model pricing
   */
  private getOpenAIPricing(modelId: string): ModelPricing | undefined {
    const pricing: Record<string, ModelPricing> = {
      // GPT-5 family
      'gpt-5.4': { inputPer1kTokens: 0.005, outputPer1kTokens: 0.02, currency: 'USD' },
      'gpt-5.3-codex': { inputPer1kTokens: 0.0025, outputPer1kTokens: 0.01, currency: 'USD' },
      'gpt-5.2-codex': { inputPer1kTokens: 0.0025, outputPer1kTokens: 0.01, currency: 'USD' },
      'gpt-5.2': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.012, currency: 'USD' },
      'gpt-5.1-codex': { inputPer1kTokens: 0.002, outputPer1kTokens: 0.008, currency: 'USD' },
      'gpt-5.1': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.012, currency: 'USD' },
      'gpt-5-codex': { inputPer1kTokens: 0.002, outputPer1kTokens: 0.008, currency: 'USD' },
      'gpt-5': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.012, currency: 'USD' },
      // GPT-4 family (legacy)
      'gpt-4o': { inputPer1kTokens: 0.005, outputPer1kTokens: 0.015, currency: 'USD' },
      'gpt-4o-mini': { inputPer1kTokens: 0.00015, outputPer1kTokens: 0.0006, currency: 'USD' },
      'gpt-4-turbo': { inputPer1kTokens: 0.01, outputPer1kTokens: 0.03, currency: 'USD' },
      'gpt-4': { inputPer1kTokens: 0.03, outputPer1kTokens: 0.06, currency: 'USD' },
      'gpt-3.5-turbo': { inputPer1kTokens: 0.0005, outputPer1kTokens: 0.0015, currency: 'USD' },
      'o1-preview': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.06, currency: 'USD' },
      'o1-mini': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.012, currency: 'USD' },
      'o3': { inputPer1kTokens: 0.01, outputPer1kTokens: 0.04, currency: 'USD' },
    };

    for (const [key, value] of Object.entries(pricing)) {
      if (modelId.startsWith(key)) {
        return value;
      }
    }

    return undefined;
  }

  /**
   * Discover Google (Gemini) models
   */
  private async discoverGoogleModels(
    config: ProviderModelConfig
  ): Promise<DiscoveredModel[]> {
    if (!config.apiKey) {
      return [];
    }

    try {
      const response = await this.httpRequest({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1/models?key=${config.apiKey}`,
        method: 'GET',
      });

      const data = JSON.parse(response) as {
        models: Array<{
          name: string;
          displayName: string;
          description: string;
          inputTokenLimit: number;
          outputTokenLimit: number;
        }>;
      };

      return data.models
        .filter((m) => m.name.includes('gemini'))
        .map((model) => ({
          id: model.name.replace('models/', ''),
          name: model.name,
          displayName: model.displayName,
          provider: 'google',
          description: model.description,
          contextLength: model.inputTokenLimit,
          maxOutputTokens: model.outputTokenLimit,
          capabilities: {
            vision: model.name.includes('vision') || model.name.includes('pro'),
            functionCalling: true,
            streaming: true,
            json: true,
            systemMessage: true,
          },
          isAvailable: true,
          lastChecked: Date.now(),
        }));
    } catch (error) {
      logger.error('Failed to discover Google models', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Discover Mistral models
   */
  private async discoverMistralModels(
    config: ProviderModelConfig
  ): Promise<DiscoveredModel[]> {
    if (!config.apiKey) {
      return [];
    }

    try {
      const response = await this.httpRequest({
        hostname: 'api.mistral.ai',
        path: '/v1/models',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
      });

      const data = JSON.parse(response) as {
        data: Array<{ id: string; owned_by: string }>;
      };

      return data.data.map((model) => ({
        id: model.id,
        name: model.id,
        displayName: this.formatModelName(model.id),
        provider: 'mistral',
        capabilities: {
          functionCalling: true,
          streaming: true,
          json: true,
          systemMessage: true,
        },
        isAvailable: true,
        lastChecked: Date.now(),
      }));
    } catch (error) {
      logger.error('Failed to discover Mistral models', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Discover Groq models
   */
  private async discoverGroqModels(
    config: ProviderModelConfig
  ): Promise<DiscoveredModel[]> {
    if (!config.apiKey) {
      return [];
    }

    try {
      const response = await this.httpRequest({
        hostname: 'api.groq.com',
        path: '/openai/v1/models',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
      });

      const data = JSON.parse(response) as {
        data: Array<{ id: string; owned_by: string; context_window?: number }>;
      };

      return data.data.map((model) => ({
        id: model.id,
        name: model.id,
        displayName: this.formatModelName(model.id),
        provider: 'groq',
        contextLength: model.context_window,
        capabilities: {
          functionCalling: true,
          streaming: true,
          json: true,
          systemMessage: true,
        },
        isAvailable: true,
        lastChecked: Date.now(),
      }));
    } catch (error) {
      logger.error('Failed to discover Groq models', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Discover Ollama models (local)
   */
  private async discoverOllamaModels(
    config: ProviderModelConfig
  ): Promise<DiscoveredModel[]> {
    const baseUrl = config.baseUrl || 'http://localhost:11434';
    const url = new URL(baseUrl);

    try {
      const response = await this.httpRequest({
        hostname: url.hostname,
        port: parseInt(url.port) || 11434,
        path: '/api/tags',
        method: 'GET',
        protocol: url.protocol,
      });

      const data = JSON.parse(response) as {
        models: Array<{ name: string; modified_at: string; size: number }>;
      };

      return data.models.map((model) => ({
        id: model.name,
        name: model.name,
        displayName: this.formatModelName(model.name),
        provider: 'ollama',
        description: `Local model (${Math.round(model.size / 1024 / 1024 / 1024)}GB)`,
        capabilities: {
          streaming: true,
          systemMessage: true,
        },
        isAvailable: true,
        lastChecked: Date.now(),
      }));
    } catch (error) {
      logger.error('Failed to discover Ollama models', error instanceof Error ? error : undefined);
      return [];
    }
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Format a model ID into a display name
   */
  private formatModelName(modelId: string): string {
    return modelId
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/Gpt/g, 'GPT')
      .replace(/^Models\//, '');
  }

  /**
   * Make an HTTP(S) request
   */
  private httpRequest(options: {
    hostname: string;
    port?: number;
    path: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    protocol?: string;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const protocol = options.protocol === 'http:' ? http : https;
      const req = protocol.request(
        {
          hostname: options.hostname,
          port: options.port,
          path: options.path,
          method: options.method,
          headers: options.headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              const error = new Error(`HTTP ${res.statusCode}: ${data}`) as Error & {
                statusCode: number;
              };
              error.statusCode = res.statusCode || 0;
              reject(error);
            }
          });
        }
      );

      req.on('error', reject);

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  }
}

// Singleton instance
let modelDiscoveryService: ModelDiscoveryService | null = null;

export function getModelDiscoveryService(): ModelDiscoveryService {
  if (!modelDiscoveryService) {
    modelDiscoveryService = new ModelDiscoveryService();
  }
  return modelDiscoveryService;
}
