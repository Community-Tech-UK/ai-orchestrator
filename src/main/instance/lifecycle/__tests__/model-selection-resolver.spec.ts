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
});
