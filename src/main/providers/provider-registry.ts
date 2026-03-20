/**
 * Provider Registry - Manages available AI providers
 */

import {
  CLAUDE_MODELS,
  OPENAI_MODELS,
  type ProviderType,
  type ProviderConfig,
  type ProviderStatus,
} from '../../shared/types/provider.types';
import { BaseProvider, ProviderFactory } from './provider-interface';
import { ClaudeCliProvider } from './claude-cli-provider';
import { CodexCliProvider } from './codex-cli-provider';
import { GeminiCliProvider } from './gemini-cli-provider';
import { AnthropicApiProvider } from './anthropic-api-provider';
import { CliDetectionService, CliInfo } from '../cli/cli-detection';

/**
 * Default provider configurations
 */
const DEFAULT_PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  'claude-cli': {
    type: 'claude-cli',
    name: 'Claude Code CLI',
    enabled: true,
    defaultModel: CLAUDE_MODELS.SONNET,
  },
  'anthropic-api': {
    type: 'anthropic-api',
    name: 'Anthropic API',
    enabled: false,
    defaultModel: CLAUDE_MODELS.SONNET,
  },
  'openai': {
    type: 'openai',
    name: 'OpenAI',
    enabled: false,
    // Don't set a default model - let Codex CLI use its configured default
    // This avoids issues with ChatGPT accounts that don't support certain models
  },
  'openai-compatible': {
    type: 'openai-compatible',
    name: 'OpenAI Compatible',
    enabled: false,
    defaultModel: OPENAI_MODELS.GPT54,
  },
  'ollama': {
    type: 'ollama',
    name: 'Ollama',
    enabled: false,
    apiEndpoint: 'http://localhost:11434',
    defaultModel: 'llama3',
  },
  'google': {
    type: 'google',
    name: 'Google AI',
    enabled: false,
    // Don't set a default model - let Gemini CLI use its configured default
    // This avoids model access issues
  },
  'amazon-bedrock': {
    type: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    enabled: false,
    defaultModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  'azure': {
    type: 'azure',
    name: 'Azure OpenAI',
    enabled: false,
    defaultModel: OPENAI_MODELS.GPT54,
  },
};

/**
 * Provider factories for each type
 */
const PROVIDER_FACTORIES: Partial<Record<ProviderType, ProviderFactory>> = {
  'claude-cli': (config) => new ClaudeCliProvider(config),
  'anthropic-api': (config) => new AnthropicApiProvider(config),
  'openai': (config) => new CodexCliProvider(config),
  'google': (config) => new GeminiCliProvider(config),
  // Future providers will be added here:
  // 'ollama': (config) => new OllamaProvider(config),
};

/**
 * Provider Registry - Singleton that manages provider configurations and creation
 */
export class ProviderRegistry {
  private configs: Map<ProviderType, ProviderConfig> = new Map();
  private statusCache: Map<ProviderType, ProviderStatus> = new Map();
  private statusCacheTime: Map<ProviderType, number> = new Map();
  private readonly STATUS_CACHE_TTL = 60000; // 1 minute

  constructor() {
    // Initialize with default configs
    for (const [type, config] of Object.entries(DEFAULT_PROVIDER_CONFIGS)) {
      this.configs.set(type as ProviderType, { ...config });
    }
  }

  /**
   * Get all provider configurations
   */
  getAllConfigs(): ProviderConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Get configuration for a specific provider
   */
  getConfig(type: ProviderType): ProviderConfig | undefined {
    return this.configs.get(type);
  }

  /**
   * Update provider configuration
   */
  updateConfig(type: ProviderType, updates: Partial<ProviderConfig>): void {
    const existing = this.configs.get(type);
    if (existing) {
      this.configs.set(type, { ...existing, ...updates });
      // Clear status cache when config changes
      this.statusCache.delete(type);
      this.statusCacheTime.delete(type);
    }
  }

  /**
   * Get enabled providers
   */
  getEnabledProviders(): ProviderConfig[] {
    return Array.from(this.configs.values()).filter((c) => c.enabled);
  }

  /**
   * Check if a provider type is supported (has a factory)
   */
  isSupported(type: ProviderType): boolean {
    return type in PROVIDER_FACTORIES;
  }

  /**
   * Create a provider instance
   */
  createProvider(type: ProviderType, configOverrides?: Partial<ProviderConfig>): BaseProvider {
    const factory = PROVIDER_FACTORIES[type];
    if (!factory) {
      throw new Error(`Provider type '${type}' is not yet implemented`);
    }

    const baseConfig = this.configs.get(type);
    if (!baseConfig) {
      throw new Error(`No configuration found for provider '${type}'`);
    }

    const config = { ...baseConfig, ...configOverrides };
    return factory(config);
  }

  /**
   * Check status of a provider (with caching)
   */
  async checkProviderStatus(type: ProviderType, forceRefresh = false): Promise<ProviderStatus> {
    // Check cache first
    if (!forceRefresh) {
      const cached = this.statusCache.get(type);
      const cachedTime = this.statusCacheTime.get(type);
      if (cached && cachedTime && Date.now() - cachedTime < this.STATUS_CACHE_TTL) {
        return cached;
      }
    }

    // If not supported, return unavailable status
    if (!this.isSupported(type)) {
      const status: ProviderStatus = {
        type,
        available: false,
        authenticated: false,
        error: `Provider '${type}' is not yet implemented`,
      };
      return status;
    }

    // Create temporary provider to check status
    try {
      const provider = this.createProvider(type);
      const status = await provider.checkStatus();

      // Cache the result
      this.statusCache.set(type, status);
      this.statusCacheTime.set(type, Date.now());

      return status;
    } catch (error) {
      const status: ProviderStatus = {
        type,
        available: false,
        authenticated: false,
        error: (error as Error).message,
      };
      return status;
    }
  }

  /**
   * Check status of all providers
   */
  async checkAllProviderStatus(forceRefresh = false): Promise<Map<ProviderType, ProviderStatus>> {
    const results = new Map<ProviderType, ProviderStatus>();

    for (const type of this.configs.keys()) {
      const status = await this.checkProviderStatus(type, forceRefresh);
      results.set(type, status);
    }

    return results;
  }

  /**
   * Get the default provider type
   */
  getDefaultProviderType(): ProviderType {
    // For now, always default to Claude CLI
    return 'claude-cli';
  }

  // ============ CLI-Specific Methods ============

  /**
   * Register CLI providers based on detected CLIs
   */
  async registerCliProviders(): Promise<void> {
    const detection = CliDetectionService.getInstance();
    const result = await detection.detectAll();

    for (const cli of result.available) {
      this.registerCliProvider(cli);
    }
  }

  /**
   * Register a single CLI provider
   */
  private registerCliProvider(cli: CliInfo): void {
    const providerType = this.mapCliToProviderType(cli.name);
    if (!providerType) return;

    const config: ProviderConfig = {
      type: providerType,
      name: cli.displayName,
      enabled: true,
      options: {
        command: cli.command,
        path: cli.path,
        version: cli.version,
        capabilities: cli.capabilities,
      },
    };

    this.configs.set(providerType, config);
    // Clear status cache when registering new provider
    this.statusCache.delete(providerType);
    this.statusCacheTime.delete(providerType);
  }

  /**
   * Map CLI name to provider type
   */
  private mapCliToProviderType(cliName: string): ProviderType | null {
    const mapping: Record<string, ProviderType> = {
      'claude': 'claude-cli',
      'codex': 'openai',
      'gemini': 'google',
      'ollama': 'ollama',
      // Note: 'copilot' not mapped - no provider implementation yet
    };
    return mapping[cliName] || null;
  }

  /**
   * Get available CLI providers
   */
  async getAvailableCliProviders(): Promise<ProviderConfig[]> {
    const detection = CliDetectionService.getInstance();
    const result = await detection.detectAll();

    return result.available.map((cli) => ({
      type: this.mapCliToProviderType(cli.name) || ('claude-cli' as ProviderType),
      name: cli.displayName,
      enabled: true,
      options: {
        command: cli.command,
        version: cli.version,
        capabilities: cli.capabilities,
      },
    }));
  }

  /**
   * Create a CLI provider by CLI name
   */
  createCliProvider(cliName: string, configOverrides?: Partial<ProviderConfig>): BaseProvider {
    const providerType = this.mapCliToProviderType(cliName);
    if (!providerType) {
      throw new Error(`Unknown CLI: ${cliName}`);
    }
    return this.createProvider(providerType, configOverrides);
  }

  /**
   * Map capability strings to ProviderCapabilities
   */
  mapCapabilitiesToProvider(caps: string[]): {
    streaming: boolean;
    toolExecution: boolean;
    multiTurn: boolean;
    vision: boolean;
    fileAttachments: boolean;
    functionCalling: boolean;
    builtInCodeTools: boolean;
  } {
    return {
      streaming: caps.includes('streaming'),
      toolExecution: caps.includes('tool-use'),
      multiTurn: caps.includes('multi-turn'),
      vision: caps.includes('vision'),
      fileAttachments: caps.includes('file-access'),
      functionCalling: caps.includes('tool-use'),
      builtInCodeTools: caps.includes('file-access') || caps.includes('shell'),
    };
  }
}

// Singleton instance
let registryInstance: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry();
  }
  return registryInstance;
}
