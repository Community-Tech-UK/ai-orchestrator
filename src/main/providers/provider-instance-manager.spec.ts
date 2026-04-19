import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./claude-cli-provider', () => ({
  ClaudeCliProvider: vi.fn().mockImplementation(() => ({ type: 'claude-cli' })),
  DEFAULT_CLAUDE_CONFIG: {
    type: 'claude-cli',
    name: 'Claude Code CLI',
    enabled: true,
    defaultModel: 'claude-sonnet',
  },
}));
vi.mock('./codex-cli-provider', () => ({
  CodexCliProvider: vi.fn().mockImplementation(() => ({ type: 'openai' })),
  DEFAULT_CODEX_CONFIG: {
    type: 'openai',
    name: 'OpenAI',
    enabled: false,
  },
}));
vi.mock('./gemini-cli-provider', () => ({
  GeminiCliProvider: vi.fn().mockImplementation(() => ({ type: 'google' })),
  DEFAULT_GEMINI_CONFIG: {
    type: 'google',
    name: 'Google AI',
    enabled: false,
  },
}));
vi.mock('./copilot-cli-provider', () => ({
  CopilotCliProvider: vi.fn().mockImplementation(() => ({ type: 'copilot' })),
  DEFAULT_COPILOT_CONFIG: {
    type: 'copilot',
    name: 'GitHub Copilot CLI',
    enabled: false,
  },
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

function makeMinimalProvider(type: string): BaseProvider {
  return { type } as unknown as BaseProvider;
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
});
