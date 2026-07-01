import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY } from 'rxjs';

function makeDescriptor(provider: string, defaultConfig: Record<string, unknown>) {
  return {
    provider,
    displayName: provider,
    capabilities: {},
    defaultConfig,
  };
}

vi.mock('./claude-cli-provider', () => ({
  ClaudeCliProvider: vi.fn().mockImplementation(() => ({ type: 'claude-cli' })),
  DEFAULT_CLAUDE_CONFIG: {
    type: 'claude-cli',
    name: 'Claude Code CLI',
    enabled: true,
    defaultModel: 'claude-sonnet',
  },
  CLAUDE_DESCRIPTOR: makeDescriptor('claude', {
    type: 'claude-cli',
    name: 'Claude Code CLI',
    enabled: true,
    defaultModel: 'claude-sonnet',
  }),
}));
vi.mock('./codex-cli-provider', () => ({
  CodexCliProvider: vi.fn().mockImplementation(() => ({ type: 'openai' })),
  DEFAULT_CODEX_CONFIG: {
    type: 'openai',
    name: 'OpenAI',
    enabled: false,
  },
  CODEX_DESCRIPTOR: makeDescriptor('codex', {
    type: 'openai',
    name: 'OpenAI',
    enabled: false,
  }),
}));
vi.mock('./gemini-cli-provider', () => ({
  GeminiCliProvider: vi.fn().mockImplementation(() => ({ type: 'google' })),
  DEFAULT_GEMINI_CONFIG: {
    type: 'google',
    name: 'Google AI',
    enabled: false,
  },
  GEMINI_DESCRIPTOR: makeDescriptor('gemini', {
    type: 'google',
    name: 'Google AI',
    enabled: false,
  }),
}));
vi.mock('./copilot-cli-provider', () => ({
  CopilotCliProvider: vi.fn().mockImplementation(() => ({ type: 'copilot' })),
  DEFAULT_COPILOT_CONFIG: {
    type: 'copilot',
    name: 'GitHub Copilot CLI',
    enabled: false,
  },
  COPILOT_DESCRIPTOR: makeDescriptor('copilot', {
    type: 'copilot',
    name: 'GitHub Copilot CLI',
    enabled: false,
  }),
}));
vi.mock('./cursor-cli-provider', () => ({
  CursorCliProvider: vi.fn().mockImplementation(() => ({ type: 'cursor' })),
  DEFAULT_CURSOR_CONFIG: {
    type: 'cursor',
    name: 'Cursor',
    enabled: false,
  },
  CURSOR_DESCRIPTOR: makeDescriptor('cursor', {
    type: 'cursor',
    name: 'Cursor',
    enabled: false,
  }),
}));
vi.mock('./anthropic-api-provider', () => ({
  AnthropicApiProvider: vi.fn().mockImplementation(() => ({ type: 'anthropic-api' })),
}));
vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: vi.fn().mockReturnValue({
      detectAll: vi.fn().mockResolvedValue({ available: [] }),
    }),
  },
}));

import { ProviderInstanceManager } from './provider-instance-manager';
import type { ProviderConfig } from '../../shared/types/provider.types';
import type { BaseProvider } from './provider-interface';
import { ProviderAdapterRegistryImpl } from './provider-adapter-registry';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type { PluginProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';

function makeMinimalProvider(type: string): BaseProvider {
  return { type } as unknown as BaseProvider;
}

function makePluginDescriptor(provider = 'plugin:acme-cli'): PluginProviderAdapterDescriptor {
  return {
    provider: provider as PluginProviderAdapterDescriptor['provider'],
    displayName: 'Acme CLI',
    capabilities: {
      interruption: true,
      permissionPrompts: false,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: false,
    },
    defaultConfig: {
      type: provider as never,
      name: 'Acme CLI',
      enabled: true,
      defaultModel: 'acme-default',
    },
    isolation: 'worker',
  };
}

function makePluginAdapter(provider = 'plugin:acme-cli'): ProviderAdapter {
  return {
    provider: provider as ProviderAdapter['provider'],
    capabilities: {
      interruption: true,
      permissionPrompts: false,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: false,
    },
    events$: EMPTY,
    getCapabilities: () => ({
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: false,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: false,
    }),
    checkStatus: async () => ({
      type: provider as never,
      available: true,
      authenticated: true,
    }),
    initialize: async () => undefined,
    sendMessage: async () => undefined,
    terminate: async () => undefined,
    getUsage: () => null,
    getPid: () => null,
    isRunning: () => false,
    getSessionId: () => '',
  };
}

describe('ProviderInstanceManager runtime registration', () => {
  let registry: ProviderInstanceManager;

  beforeEach(() => {
    registry = new ProviderInstanceManager();
  });

  it('registers a custom provider factory and creates an instance', () => {
    registry.registerProvider(
      'ollama',
      (config) => makeMinimalProvider(config.type),
      {
        name: 'Ollama',
        enabled: true,
        apiEndpoint: 'http://localhost:11434',
        defaultModel: 'llama3',
      },
    );

    expect(registry.isSupported('ollama')).toBe(true);
    expect(registry.createProvider('ollama')).toBeDefined();
  });

  it('allows overriding a built-in provider factory', () => {
    let factoryCalled = false;

    registry.registerProvider('claude-cli', (config) => {
      factoryCalled = true;
      return makeMinimalProvider(config.type);
    });

    registry.createProvider('claude-cli');
    expect(factoryCalled).toBe(true);
  });

  it('unregisterProvider removes the factory', () => {
    registry.registerProvider('ollama', (config) => makeMinimalProvider(config.type), {
      name: 'Ollama',
      enabled: true,
    });

    expect(registry.isSupported('ollama')).toBe(true);
    registry.unregisterProvider('ollama');
    expect(registry.isSupported('ollama')).toBe(false);
  });

  it('throws when creating a provider with no registered factory', () => {
    expect(() => registry.createProvider('amazon-bedrock')).toThrow(
      "Provider type 'amazon-bedrock' is not yet implemented",
    );
  });

  it('merges default config into the registry when registering a provider', () => {
    const partialConfig: Partial<ProviderConfig> = {
      name: 'My Ollama',
      enabled: true,
      defaultModel: 'mistral',
    };

    registry.registerProvider(
      'ollama',
      (config) => makeMinimalProvider(config.type),
      partialConfig,
    );

    const config = registry.getConfig('ollama');
    expect(config).toBeDefined();
    expect(config?.name).toBe('My Ollama');
    expect(config?.defaultModel).toBe('mistral');
  });

  it('built-in providers remain supported by default', () => {
    expect(registry.isSupported('claude-cli')).toBe(true);
    expect(registry.isSupported('anthropic-api')).toBe(true);
    expect(registry.isSupported('openai')).toBe(true);
    expect(registry.isSupported('google')).toBe(true);
  });

  it('creates built-in provider instances through the adapter registry', () => {
    expect(registry.createProvider('openai')).toEqual({ type: 'openai' });
    expect(registry.createProvider('cursor')).toEqual({ type: 'cursor' });
  });

  it('surfaces only invokable plugin providers after a host bridge is registered', async () => {
    const adapterRegistry = new ProviderAdapterRegistryImpl();
    registry = new ProviderInstanceManager(adapterRegistry);
    adapterRegistry.registerProviderAdapter(
      makePluginDescriptor('plugin:descriptor-only'),
      'factory:descriptor-only',
    );

    expect(registry.getAllConfigs().map((config) => config.type))
      .not
      .toContain('plugin:descriptor-only');
    expect(registry.isSupported('plugin:descriptor-only')).toBe(false);

    const descriptor = makePluginDescriptor();
    const adapter = makePluginAdapter();
    const bridge = {
      createProviderAdapter: vi.fn(() => adapter),
    };
    adapterRegistry.registerPluginProviderAdapter(descriptor, 'factory:acme', bridge);

    expect(registry.getAllConfigs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'plugin:acme-cli',
          name: 'Acme CLI',
          enabled: true,
          defaultModel: 'acme-default',
        }),
      ]),
    );
    expect(registry.isSupported('plugin:acme-cli')).toBe(true);
    await expect(registry.checkProviderStatus('plugin:acme-cli' as never))
      .resolves
      .toMatchObject({
        type: 'plugin:acme-cli',
        available: true,
        authenticated: true,
      });
    expect(registry.createProvider('plugin:acme-cli')).toBe(adapter);
    expect(bridge.createProviderAdapter).toHaveBeenCalledWith(
      descriptor,
      'factory:acme',
      expect.objectContaining({
        type: 'plugin:acme-cli',
        name: 'Acme CLI',
      }),
    );

    adapterRegistry.unregisterPluginProviderAdapter('plugin:acme-cli');
    expect(registry.getAllConfigs().map((config) => config.type))
      .not
      .toContain('plugin:acme-cli');
    await expect(registry.checkProviderStatus('plugin:acme-cli' as never))
      .resolves
      .toMatchObject({
        type: 'plugin:acme-cli',
        available: false,
        authenticated: false,
      });
  });
});
