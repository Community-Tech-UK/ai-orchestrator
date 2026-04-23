import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  ModelCapabilitiesRegistry,
  getModelCapabilitiesRegistry,
  type ModelCapabilities,
} from '../model-capabilities';

describe('ModelCapabilitiesRegistry', () => {
  beforeEach(() => {
    ModelCapabilitiesRegistry._resetForTesting();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = ModelCapabilitiesRegistry.getInstance();
      const b = ModelCapabilitiesRegistry.getInstance();
      expect(a).toBe(b);
    });

    it('getModelCapabilitiesRegistry() convenience getter returns the singleton', () => {
      expect(getModelCapabilitiesRegistry()).toBe(ModelCapabilitiesRegistry.getInstance());
    });
  });

  describe('getCapabilities — known Claude models', () => {
    it('returns 1M context window for claude opus', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'opus');
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('returns 1M context window for claude sonnet', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'sonnet');
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('returns 200K context window for claude haiku', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'haiku');
      expect(caps.contextWindow).toBe(200_000);
    });

    it('marks claude opus as supportsThinking = true', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'opus');
      expect(caps.supportsThinking).toBe(true);
    });

    it('marks claude haiku as supportsThinking = false', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'haiku');
      expect(caps.supportsThinking).toBe(false);
    });

    it('includes pricing for claude sonnet', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'sonnet');
      expect(caps.pricing).toBeDefined();
      expect(caps.pricing!.inputPerMillion).toBe(3.0);
      expect(caps.pricing!.outputPerMillion).toBe(15.0);
    });

    it('includes pricing for claude opus', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'opus');
      expect(caps.pricing).toBeDefined();
      expect(caps.pricing!.inputPerMillion).toBe(5.0);
      expect(caps.pricing!.outputPerMillion).toBe(25.0);
    });
  });

  describe('getCapabilities — known OpenAI models', () => {
    it('returns 200K context window for gpt-5.5', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('openai', 'gpt-5.5');
      expect(caps.contextWindow).toBe(200_000);
    });

    it('returns 200K context window for o1', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('openai', 'o1');
      expect(caps.contextWindow).toBe(200_000);
    });
  });

  describe('getCapabilities — known Gemini models', () => {
    it('returns 1M context window for gemini-flash', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('google', 'gemini-flash');
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('returns 2M context window for gemini-pro', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('google', 'gemini-pro');
      expect(caps.contextWindow).toBe(2_000_000);
    });
  });

  describe('getCapabilities — unknown model fallback', () => {
    it('returns sensible defaults for an unknown provider+model', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('unknown-provider', 'unknown-model-xyz');
      expect(caps.contextWindow).toBe(200_000);
      expect(caps.maxOutputTokens).toBe(4096);
      expect(caps.supportsThinking).toBe(false);
      expect(caps.supportsBatching).toBe(false);
    });
  });

  describe('TTL cache', () => {
    it('returns the same object reference on repeated calls within TTL', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps1 = registry.getCapabilities('claude', 'sonnet');
      const caps2 = registry.getCapabilities('claude', 'sonnet');
      expect(caps1).toBe(caps2);
    });

    it('re-computes after TTL expires', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps1 = registry.getCapabilities('claude', 'haiku');
      (registry as unknown as { capabilityCache: Map<string, { caps: ModelCapabilities; expiresAt: number }> })
        .capabilityCache.forEach((_v, k) => {
          (registry as unknown as { capabilityCache: Map<string, { caps: ModelCapabilities; expiresAt: number }> })
            .capabilityCache.set(k, { caps: _v.caps, expiresAt: Date.now() - 1 });
        });
      const caps2 = registry.getCapabilities('claude', 'haiku');
      expect(caps2).not.toBe(caps1);
      expect(caps2.contextWindow).toBe(caps1.contextWindow);
    });
  });

  describe('enrichFromDiscovery', () => {
    it('merges runtime-discovered data with known static data', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      registry.enrichFromDiscovery('claude', 'sonnet', { thinkingBudget: 8192 });
      const caps = registry.getCapabilities('claude', 'sonnet');
      expect(caps.thinkingBudget).toBe(8192);
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('runtime enrichment overrides static values when provided', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      registry.enrichFromDiscovery('claude', 'haiku', { contextWindow: 400_000 });
      const caps = registry.getCapabilities('claude', 'haiku');
      expect(caps.contextWindow).toBe(400_000);
    });

    it('enriching unknown model creates a new entry using defaults + enrichment', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      registry.enrichFromDiscovery('newco', 'model-x', { contextWindow: 300_000, supportsThinking: true });
      const caps = registry.getCapabilities('newco', 'model-x');
      expect(caps.contextWindow).toBe(300_000);
      expect(caps.supportsThinking).toBe(true);
    });
  });

  describe('provider alias normalisation', () => {
    it('treats "claude-cli" as unknown (not aliased to "claude")', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude-cli', 'opus');
      expect(caps.contextWindow).toBe(200_000);
    });

    it('normalises model name casing', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const lower = registry.getCapabilities('claude', 'opus');
      const upper = registry.getCapabilities('CLAUDE', 'OPUS');
      expect(lower.contextWindow).toBe(upper.contextWindow);
    });
  });
});
