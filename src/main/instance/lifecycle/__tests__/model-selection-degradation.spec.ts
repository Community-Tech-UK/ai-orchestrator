import { describe, expect, it } from 'vitest';
import {
  createModelSelectionDegradationNotice,
  findEquivalentModel,
  resolveAvailableModelSelection,
  resolveRuntimeChangeModel,
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
      allowDynamicModel: true,
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
      allowDynamicModel: true,
    });

    expect(requestedModel).toHaveLength(MAX_MODEL_ID_LENGTH + 4);
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.degradation).toEqual({
      provider: 'codex',
      requestedModel,
      fallbackModel: 'gpt-5.3-codex',
      fallbackKind: 'default',
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
      fallbackKind: 'default',
      reason: 'model-unavailable',
    });
  });

  it('replaces a retired model with the newest one of the same family and effort', () => {
    // The live Cursor list after it dropped grok-4.5-xhigh (7 November 2026).
    const knownModelIds = [
      'auto',
      'cursor-grok-4.5-high',
      'grok-4.7-high',
      'grok-4.7-xhigh-fast',
      'grok-4.7-xhigh',
      'cursor-grok-4.6-xhigh',
      'gpt-5.3-codex-xhigh',
    ];

    const result = resolveAvailableModelSelection({
      provider: 'cursor',
      requestedModel: 'grok-4.5-xhigh',
      knownModelIds,
      fallbackModel: 'auto',
    });

    expect(result).toEqual({
      model: 'grok-4.7-xhigh',
      degradation: {
        provider: 'cursor',
        requestedModel: 'grok-4.5-xhigh',
        fallbackModel: 'grok-4.7-xhigh',
        fallbackKind: 'equivalent',
        reason: 'model-unavailable',
      },
    });
  });

  it('falls back to the provider default when no model shares the family and effort', () => {
    const result = resolveAvailableModelSelection({
      provider: 'cursor',
      requestedModel: 'grok-4.5-xhigh',
      knownModelIds: ['auto', 'grok-4.7-high', 'grok-4.7-xhigh-fast'],
      fallbackModel: 'auto',
    });

    expect(result.model).toBe('auto');
    expect(result.degradation?.fallbackKind).toBe('default');
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

describe('findEquivalentModel', () => {
  it('ranks multi-part Claude versions numerically and keeps thinking variants apart', () => {
    expect(findEquivalentModel('claude', 'claude-opus-4-7', [
      'claude-opus-4-8',
      'claude-opus-5-5',
      'claude-opus-5-thinking-high',
      'claude-sonnet-5-5',
    ])).toBe('claude-opus-5-5');
  });

  it('matches labelled ids and ignores release dates when ranking', () => {
    expect(findEquivalentModel('antigravity', 'Gemini 3.1 Flash (Medium)', [
      'Gemini 3.8 Flash (Low)',
      'Gemini 3.8 Flash (Medium)',
    ])).toBe('Gemini 3.8 Flash (Medium)');
    expect(findEquivalentModel('claude', 'claude-sonnet-4-1', [
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-6',
    ])).toBe('claude-sonnet-4-6');
  });

  it('finds nothing for ids without a version', () => {
    expect(findEquivalentModel('claude', 'opus[1m]', ['opus', 'claude-opus-5-5'])).toBeUndefined();
  });
});

describe('createModelSelectionDegradationNotice', () => {
  it('creates a user-visible system note that preserves degradation metadata', () => {
    const notice = createModelSelectionDegradationNotice({
      provider: 'claude',
      requestedModel: 'claude-retired-model',
      fallbackModel: 'claude-opus-4-8',
      fallbackKind: 'default',
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
      fallbackKind: 'default',
      reason: 'model-unavailable',
    });
  });

  it('says when the replacement is the closest equivalent', () => {
    const notice = createModelSelectionDegradationNotice({
      provider: 'cursor',
      requestedModel: 'grok-4.5-xhigh',
      fallbackModel: 'grok-4.7-xhigh',
      fallbackKind: 'equivalent',
      reason: 'model-unavailable',
    });

    expect(notice.content).toBe(
      'Model "grok-4.5-xhigh" is no longer available for cursor. '
      + 'Using "grok-4.7-xhigh", the closest match it still offers. The saved selection was left unchanged.',
    );
    expect(notice.metadata?.['fallbackKind']).toBe('equivalent');
  });
});

describe('resolveRuntimeChangeModel', () => {
  it('upgrades an explicitly replaced model before validation without degrading to the default', () => {
    expect(resolveRuntimeChangeModel({
      provider: 'claude',
      requestedModel: 'claude-fable-5',
      knownModelIds: ['claude-fable-5-1', 'opus[1m]'],
      fallbackModel: 'opus[1m]',
      modelSource: 'requested',
    })).toEqual({
      model: 'claude-fable-5-1',
      userVisible: false,
    });
  });
});
