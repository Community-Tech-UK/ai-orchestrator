import { describe, expect, it, vi } from 'vitest';

import { ModelSelectionResolver } from '../model-selection-resolver';

describe('ModelSelectionResolver', () => {
  it('uses a local-model target directly without consulting the provider catalog', async () => {
    const getKnownModels = vi.fn();
    const resolver = new ModelSelectionResolver({ getKnownModels });

    const result = await resolver.resolve({
      provider: 'claude',
      configModelOverride: 'powerful',
      localModelId: 'qwen3:8b',
      defaultModel: 'balanced',
    });

    expect(result).toEqual({ model: 'qwen3:8b' });
    expect(getKnownModels).not.toHaveBeenCalled();
  });

  it('resolves a tier before validating it against the provider catalog', async () => {
    const getKnownModels = vi.fn().mockResolvedValue(['gpt-5.6-terra']);
    const resolver = new ModelSelectionResolver({ getKnownModels });

    const result = await resolver.resolve({
      provider: 'codex',
      configModelOverride: 'balanced',
    });

    expect(result).toEqual({
      model: 'gpt-5.6-terra',
      tierResolution: { tier: 'balanced', model: 'gpt-5.6-terra' },
    });
    expect(getKnownModels).toHaveBeenCalledWith('codex');
  });

  it('returns degradation metadata when a stale selection falls back', async () => {
    const getKnownModels = vi.fn().mockResolvedValue(['gemini-3.1-pro-preview']);
    const resolver = new ModelSelectionResolver({
      getKnownModels,
      getDefaultModel: () => 'gemini-3.1-pro-preview',
    });

    const result = await resolver.resolve({
      provider: 'gemini',
      configModelOverride: 'gemini-retired-preview',
    });

    expect(result).toEqual({
      model: 'gemini-3.1-pro-preview',
      degradation: {
        provider: 'gemini',
        requestedModel: 'gemini-retired-preview',
        fallbackModel: 'gemini-3.1-pro-preview',
        reason: 'model-unavailable',
      },
      // LT-016: an explicit override is the user's own choice, so this
      // degradation SHOULD reach them.
      modelSource: 'requested',
      knownModelCount: 1,
    });
  });

  it('keeps Codex-shaped dynamic model ids that discovery has not listed', async () => {
    const resolver = new ModelSelectionResolver({
      getKnownModels: vi.fn().mockResolvedValue(['gpt-5.3-codex']),
      getDefaultModel: () => 'gpt-5.3-codex',
    });

    await expect(resolver.resolve({
      provider: 'codex',
      configModelOverride: 'gpt-5.9-codex',
    })).resolves.toEqual({ model: 'gpt-5.9-codex' });
  });

  it('lets a remote provider choose its own default instead of inheriting coordinator defaults', async () => {
    const getKnownModels = vi.fn();
    const resolver = new ModelSelectionResolver({ getKnownModels });

    await expect(resolver.resolve({
      provider: 'antigravity',
      executionTarget: 'remote',
      defaultModelByProvider: { antigravity: 'Gemini 3.5 Flash (Medium)' },
      defaultModel: 'opus',
    })).resolves.toEqual({ model: undefined });
    expect(getKnownModels).not.toHaveBeenCalled();
  });

  it('preserves an explicit remote model without validating it against the coordinator catalog', async () => {
    const getKnownModels = vi.fn();
    const resolver = new ModelSelectionResolver({ getKnownModels });

    await expect(resolver.resolve({
      provider: 'antigravity',
      executionTarget: 'remote',
      configModelOverride: 'Gemini 3.7 Pro (High)',
      defaultModelByProvider: { antigravity: 'Gemini 3.5 Flash (Medium)' },
    })).resolves.toEqual({ model: 'Gemini 3.7 Pro (High)' });
    expect(getKnownModels).not.toHaveBeenCalled();
  });

  it('upgrades an explicitly replaced model before local catalog validation', async () => {
    const resolver = new ModelSelectionResolver({
      getKnownModels: vi.fn().mockResolvedValue(['claude-fable-5-1', 'opus[1m]']),
      getDefaultModel: () => 'opus[1m]',
    });

    await expect(resolver.resolve({
      provider: 'claude',
      configModelOverride: 'claude-fable-5',
    })).resolves.toEqual({ model: 'claude-fable-5-1' });
  });

  it('upgrades an explicitly replaced model before returning it to a remote worker', async () => {
    const getKnownModels = vi.fn();
    const resolver = new ModelSelectionResolver({ getKnownModels });

    await expect(resolver.resolve({
      provider: 'claude',
      executionTarget: 'remote',
      configModelOverride: 'claude-fable-5',
    })).resolves.toEqual({ model: 'claude-fable-5-1' });
    expect(getKnownModels).not.toHaveBeenCalled();
  });

  /**
   * LT-016 (create path). The global `defaultModel` is provider-agnostic and is
   * typically a Claude id, so it is offered to every provider and correctly
   * rejected by most. Surfacing "your model is no longer available" for a
   * choice the user never made for THAT provider is the trust bug; provenance
   * is what lets the caller suppress it. The swap path already did this — this
   * pins the create path to the same contract.
   */
  describe('degradation provenance (LT-016)', () => {
    const getKnownModels = vi.fn().mockResolvedValue(['gemini-3.1-pro-preview']);
    const getDefaultModel = vi.fn().mockReturnValue('gemini-3.1-pro-preview');

    it('marks a rejection traced to the global default as global-default', async () => {
      const resolver = new ModelSelectionResolver({ getKnownModels, getDefaultModel });
      const result = await resolver.resolve({
        provider: 'copilot',
        defaultModel: 'opus[1m]',
      });
      expect(result.degradation).toBeDefined();
      expect(result.modelSource).toBe('global-default');
    });

    it('marks an explicitly requested model as requested', async () => {
      const resolver = new ModelSelectionResolver({ getKnownModels, getDefaultModel });
      const result = await resolver.resolve({
        provider: 'copilot',
        configModelOverride: 'definitely-not-a-model',
        defaultModel: 'opus[1m]',
      });
      expect(result.degradation).toBeDefined();
      expect(result.modelSource).toBe('requested');
    });

    it('marks a stale per-provider remembered model as remembered', async () => {
      const resolver = new ModelSelectionResolver({ getKnownModels, getDefaultModel });
      const result = await resolver.resolve({
        provider: 'copilot',
        defaultModelByProvider: { copilot: 'retired-copilot-model' },
        defaultModel: 'opus[1m]',
      });
      expect(result.degradation).toBeDefined();
      expect(result.modelSource).toBe('remembered');
    });

    it('marks an agent-pinned model as agent', async () => {
      const resolver = new ModelSelectionResolver({ getKnownModels, getDefaultModel });
      const result = await resolver.resolve({
        provider: 'copilot',
        agentModelOverride: 'agent-pinned-ghost',
        defaultModel: 'opus[1m]',
      });
      expect(result.modelSource).toBe('agent');
    });
  });
});
