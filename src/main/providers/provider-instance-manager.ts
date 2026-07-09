/**
 * Provider Instance Manager - Manages available AI providers (configs,
 * factories, status caching, CLI detection wiring).
 *
 * Wave 2 introduced a separate `ProviderAdapterRegistry` (see
 * `@sdk/provider-adapter-registry`) that owns the normalized adapter surface
 * built-in providers will register against. This class accepts that registry
 * via its constructor so future tasks can delegate instance creation to it.
 */

import {
  CLAUDE_MODELS,
  OPENAI_MODELS,
  type ProviderConfigType,
  type ProviderType,
  type ProviderConfig,
  type ProviderStatus,
} from '../../shared/types/provider.types';
import type { BuiltInProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type {
  PluginProviderAdapterRegistry,
  PluginProviderId,
  ProviderAdapterRegistry,
  RegisteredPluginProviderAdapter,
} from '@sdk/provider-adapter-registry';
import { BaseProvider, ProviderFactory } from './provider-interface';
import { DEFAULT_CLAUDE_CONFIG } from './claude-cli-provider';
import { DEFAULT_CODEX_CONFIG } from './codex-cli-provider';
import { DEFAULT_GEMINI_CONFIG } from './gemini-cli-provider';
import { DEFAULT_COPILOT_CONFIG } from './copilot-cli-provider';
import { DEFAULT_CURSOR_CONFIG } from './cursor-cli-provider';
import { DEFAULT_GROK_CONFIG } from './grok-cli-provider';
import { AnthropicApiProvider } from './anthropic-api-provider';
import { CliDetectionService, CliInfo } from '../cli/cli-detection';
import { providerAdapterRegistry } from './provider-adapter-registry';
import { registerBuiltInProviders } from './register-built-in-providers';

/**
 * Default provider configurations.
 *
 * CLI-adapter entries (claude, codex, gemini, copilot, cursor) are co-located
 * with their provider files and re-imported here so the descriptor exported
 * from each provider module stays the single source of truth for default config.
 */
export const DEFAULT_PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  'claude-cli': DEFAULT_CLAUDE_CONFIG,
  'anthropic-api': {
    type: 'anthropic-api',
    name: 'Anthropic API',
    enabled: false,
    defaultModel: CLAUDE_MODELS.OPUS,
  },
  'openai': DEFAULT_CODEX_CONFIG,
  'openai-compatible': {
    type: 'openai-compatible',
    name: 'OpenAI Compatible',
    enabled: false,
    defaultModel: OPENAI_MODELS.GPT55,
  },
  'ollama': {
    type: 'ollama',
    name: 'Ollama',
    enabled: false,
    apiEndpoint: 'http://localhost:11434',
    defaultModel: 'llama3',
  },
  'google': DEFAULT_GEMINI_CONFIG,
  'copilot': DEFAULT_COPILOT_CONFIG,
  'cursor': DEFAULT_CURSOR_CONFIG,
  'grok': DEFAULT_GROK_CONFIG,
  'amazon-bedrock': {
    type: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    enabled: false,
    defaultModel: 'anthropic.claude-sonnet-4-6-20260401-v1:0',
  },
  'azure': {
    type: 'azure',
    name: 'Azure OpenAI',
    enabled: false,
    defaultModel: OPENAI_MODELS.GPT55,
  },
};

const REGISTRY_PROVIDER_BY_TYPE: Partial<Record<ProviderType, BuiltInProviderName>> = {
  'claude-cli': 'claude',
  'openai': 'codex',
  'google': 'gemini',
  'copilot': 'copilot',
  'cursor': 'cursor',
  'grok': 'grok',
};

/**
 * Provider Instance Manager - Singleton that manages provider configurations
 * and creation.
 */
export class ProviderInstanceManager {
  private configs = new Map<string, ProviderConfig>();
  private factories = new Map<string, ProviderFactory>();
  private statusCache = new Map<string, ProviderStatus>();
  private statusCacheTime = new Map<string, number>();
  private readonly STATUS_CACHE_TTL = 60000; // 1 minute
  private readonly adapterRegistry: ProviderAdapterRegistry & Partial<PluginProviderAdapterRegistry>;

  constructor(adapterRegistry: ProviderAdapterRegistry & Partial<PluginProviderAdapterRegistry> = providerAdapterRegistry) {
    this.adapterRegistry = adapterRegistry;
    registerBuiltInProviders(this.adapterRegistry);
    // Initialize with default configs
    for (const [type, config] of Object.entries(DEFAULT_PROVIDER_CONFIGS)) {
      this.configs.set(type, { ...config });
    }
    this.factories.set('anthropic-api', (config) => new AnthropicApiProvider(config));
  }

  /**
   * Get all provider configurations
   */
  getAllConfigs(): ProviderConfig[] {
    return [
      ...Array.from(this.configs.values()),
      ...this.listCreatablePluginProviders().map((registration) =>
        this.toPluginProviderConfig(registration)
      ),
    ];
  }

  /**
   * Get configuration for a specific provider
   */
  getConfig(type: string): ProviderConfig | undefined {
    return this.configs.get(type) ?? this.getPluginProviderConfig(type);
  }

  /**
   * Update provider configuration
   */
  updateConfig(type: string, updates: Partial<ProviderConfig>): void {
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
    return this.getAllConfigs().filter((c) => c.enabled);
  }

  /**
   * Check if a provider type is supported (has a factory)
   */
  isSupported(type: string): boolean {
    if (this.factories.has(type)) {
      return true;
    }

    const providerName = REGISTRY_PROVIDER_BY_TYPE[type as ProviderType];
    if (!providerName) {
      return this.isCreatablePluginProvider(type);
    }

    try {
      this.adapterRegistry.get(providerName);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register a provider factory at runtime.
   */
  registerProvider(
    type: string,
    factory: ProviderFactory,
    defaultConfig?: Partial<ProviderConfig>,
  ): void {
    this.factories.set(type, factory);
    if (defaultConfig) {
      const existing = this.configs.get(type);
      const merged: ProviderConfig = {
        type: (existing?.type ?? type) as ProviderType,
        name: defaultConfig.name ?? existing?.name ?? type,
        enabled: defaultConfig.enabled ?? existing?.enabled ?? false,
        ...existing,
        ...defaultConfig,
      };
      this.configs.set(type, merged);
    }
    this.statusCache.delete(type);
    this.statusCacheTime.delete(type);
  }

  /**
   * Unregister a provider factory.
   * Primarily useful in tests and plugin teardown.
   */
  unregisterProvider(type: string): void {
    this.factories.delete(type);
    this.statusCache.delete(type);
    this.statusCacheTime.delete(type);
  }

  /**
   * Create a provider instance
   *
   * wave2-task12 — when built-ins are registered on `adapterRegistry`,
   * consider delegating to `this.adapterRegistry.create(...)` so the SDK
   * surface becomes the single entry point for provider instantiation.
   */
  createProvider(type: ProviderConfigType | string, configOverrides?: Partial<ProviderConfig>): ProviderAdapter {
    const baseConfig = this.configs.get(type);
    if (!baseConfig) {
      const pluginConfig = this.getPluginProviderConfig(type);
      if (pluginConfig) {
        return this.createPluginProvider(type, {
          ...pluginConfig,
          ...configOverrides,
        });
      }
      throw new Error(`No configuration found for provider '${type}'`);
    }

    const config = { ...baseConfig, ...configOverrides };
    const localFactory = this.factories.get(type);
    if (localFactory) {
      return localFactory(config);
    }

    const providerName = REGISTRY_PROVIDER_BY_TYPE[type as ProviderType];
    if (providerName) {
      return this.adapterRegistry.create(providerName, config) as BaseProvider;
    }

    throw new Error(`Provider type '${type}' is not yet implemented`);
  }

  /**
   * Check status of a provider (with caching)
   */
  async checkProviderStatus(type: ProviderConfigType | string, forceRefresh = false): Promise<ProviderStatus> {
    if (!this.isSupported(type)) {
      this.statusCache.delete(type);
      this.statusCacheTime.delete(type);
      const status: ProviderStatus = {
        type: type as ProviderStatus['type'],
        available: false,
        authenticated: false,
        error: `Provider '${type}' is not yet implemented`,
      };
      return status;
    }

    // Check cache first
    if (!forceRefresh) {
      const cached = this.statusCache.get(type);
      const cachedTime = this.statusCacheTime.get(type);
      if (cached && cachedTime && Date.now() - cachedTime < this.STATUS_CACHE_TTL) {
        return cached;
      }
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
        type: type as ProviderStatus['type'],
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
  async checkAllProviderStatus(forceRefresh = false): Promise<Map<ProviderConfigType, ProviderStatus>> {
    const results = new Map<ProviderConfigType, ProviderStatus>();

    for (const config of this.getAllConfigs()) {
      const status = await this.checkProviderStatus(config.type, forceRefresh);
      results.set(config.type, status);
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
   * Map CLI name to provider type.
   *
   * Lifted to a class-level readonly constant so that tests and future
   * callers can introspect the mapping without recreating the Record on
   * every method invocation.
   */
  private readonly cliToProviderType: Record<string, ProviderType> = {
    'claude': 'claude-cli',
    'codex': 'openai',
    'gemini': 'google',
    'copilot': 'copilot',
    'cursor': 'cursor',
    'ollama': 'ollama',
  };

  private mapCliToProviderType(cliName: string): ProviderType | null {
    return this.cliToProviderType[cliName] || null;
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
  createCliProvider(cliName: string, configOverrides?: Partial<ProviderConfig>): ProviderAdapter {
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

  private listCreatablePluginProviders(): readonly RegisteredPluginProviderAdapter[] {
    return this.adapterRegistry.listCreatablePluginProviderAdapters?.() ?? [];
  }

  private getPluginProviderConfig(type: string): ProviderConfig | undefined {
    const registration = this.listCreatablePluginProviders()
      .find((pluginProvider) => pluginProvider.descriptor.provider === type);
    return registration ? this.toPluginProviderConfig(registration) : undefined;
  }

  private isCreatablePluginProvider(type: string): type is PluginProviderId {
    return this.listCreatablePluginProviders()
      .some((pluginProvider) => pluginProvider.descriptor.provider === type);
  }

  private createPluginProvider(type: string, config: ProviderConfig): ProviderAdapter {
    if (!this.isCreatablePluginProvider(type)) {
      throw new Error(`Provider '${type}' is not yet implemented`);
    }
    const create = this.adapterRegistry.createPluginProviderAdapter;
    if (!create) {
      throw new Error(`Provider '${type}' has no plugin provider bridge`);
    }
    return create.call(this.adapterRegistry, type, config);
  }

  private toPluginProviderConfig(registration: RegisteredPluginProviderAdapter): ProviderConfig {
    return {
      ...registration.descriptor.defaultConfig,
      type: registration.descriptor.provider,
      name: registration.descriptor.displayName,
    };
  }
}

// Singleton instance
let instanceManagerSingleton: ProviderInstanceManager | null = null;

export function getProviderInstanceManager(): ProviderInstanceManager {
  if (!instanceManagerSingleton) {
    instanceManagerSingleton = new ProviderInstanceManager();
  }
  return instanceManagerSingleton;
}
