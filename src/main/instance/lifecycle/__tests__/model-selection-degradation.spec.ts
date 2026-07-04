import { describe, expect, it } from 'vitest';
import {
  createModelSelectionDegradationNotice,
  resolveAvailableModelSelection,
} from '../model-selection-degradation';
import { MAX_MODEL_ID_LENGTH } from '../../../../shared/types/provider.types';

describe('resolveAvailableModelSelection', () => {
  it('keeps a selected model that is still in the provider catalog', () => {
    const result = resolveAvailableModelSelection({
      provider: 'claude',
      requestedModel: 'claude-sonnet-4-6',
      knownModelIds: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      fallbackModel: 'claude-opus-4-8',
    });

    expect(result).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('keeps Codex-shaped dynamic ids even when discovery did not list them', () => {
    const result = resolveAvailableModelSelection({
      provider: 'codex',
      requestedModel: 'gpt-5.9-codex',
      knownModelIds: ['gpt-5.3-codex'],
      fallbackModel: 'gpt-5.3-codex',
      allowDynamicCodexModel: true,
    });

    expect(result).toEqual({ model: 'gpt-5.9-codex' });
  });

  it('degrades overlong requested models before Codex dynamic tolerance or catalog fail-open', () => {
    const requestedModel = `gpt-${'a'.repeat(MAX_MODEL_ID_LENGTH)}`;

    const result = resolveAvailableModelSelection({
      provider: 'codex',
      requestedModel,
      knownModelIds: [],
      fallbackModel: 'gpt-5.3-codex',
      allowDynamicCodexModel: true,
    });

    expect(requestedModel).toHaveLength(MAX_MODEL_ID_LENGTH + 4);
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.degradation).toEqual({
      provider: 'codex',
      requestedModel,
      fallbackModel: 'gpt-5.3-codex',
      reason: 'model-unavailable',
    });
  });

  it('degrades a stale stored model to the provider default without deleting the original slug', () => {
    const result = resolveAvailableModelSelection({
      provider: 'gemini',
      requestedModel: 'gemini-retired-preview',
      knownModelIds: ['gemini-3.1-pro-preview'],
      fallbackModel: 'gemini-3.1-pro-preview',
    });

    expect(result.model).toBe('gemini-3.1-pro-preview');
    expect(result.degradation).toEqual({
      provider: 'gemini',
      requestedModel: 'gemini-retired-preview',
      fallbackModel: 'gemini-3.1-pro-preview',
      reason: 'model-unavailable',
    });
  });

  it('does not degrade when the provider catalog is unavailable', () => {
    const result = resolveAvailableModelSelection({
      provider: 'claude',
      requestedModel: 'claude-future-model',
      knownModelIds: [],
      fallbackModel: 'claude-opus-4-8',
    });

    expect(result).toEqual({ model: 'claude-future-model' });
  });
});

describe('createModelSelectionDegradationNotice', () => {
  it('creates a user-visible system note that preserves degradation metadata', () => {
    const notice = createModelSelectionDegradationNotice({
      provider: 'claude',
      requestedModel: 'claude-retired-model',
      fallbackModel: 'claude-opus-4-8',
      reason: 'model-unavailable',
    });

    expect(notice.type).toBe('system');
    expect(notice.content).toContain('claude-retired-model');
    expect(notice.content).toContain('no longer available');
    expect(notice.content).toContain('claude-opus-4-8');
    expect(notice.content).toContain('saved selection was left unchanged');
    expect(notice.metadata).toEqual({
      kind: 'model-selection-degraded',
      provider: 'claude',
      requestedModel: 'claude-retired-model',
      fallbackModel: 'claude-opus-4-8',
      reason: 'model-unavailable',
    });
  });
});
