import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./claude-cli-provider', () => ({
  ClaudeCliProvider: vi.fn().mockImplementation(() => ({ type: 'claude-cli' })),
}));
vi.mock('./codex-cli-provider', () => ({
  CodexCliProvider: vi.fn().mockImplementation(() => ({ type: 'openai' })),
}));
vi.mock('./gemini-cli-provider', () => ({
  GeminiCliProvider: vi.fn().mockImplementation(() => ({ type: 'google' })),
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

import { ProviderRegistry } from './provider-registry';
import type { ProviderConfig } from '../../shared/types/provider.types';
import type { BaseProvider } from './provider-interface';

function makeMinimalProvider(type: string): BaseProvider {
  return { type } as unknown as BaseProvider;
}

describe('ProviderRegistry runtime registration', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
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
});
