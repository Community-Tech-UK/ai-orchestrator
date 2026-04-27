import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODELS,
  COPILOT_MODELS,
  DEFAULT_MODELS,
  PROVIDER_MODEL_LIST,
  getPrimaryModelForProvider,
  getProviderModelContextWindow,
  normalizeModelAliasForProvider,
  normalizeModelForProvider,
} from './provider.types';

describe('provider type helpers', () => {
  it('returns 1M context for explicit Claude 1M variants', () => {
    expect(getProviderModelContextWindow('claude', CLAUDE_MODELS.SONNET_1M)).toBe(1000000);
    expect(getProviderModelContextWindow('claude-cli', CLAUDE_MODELS.OPUS_1M)).toBe(1000000);
    expect(
      getProviderModelContextWindow('anthropic-api', 'claude-sonnet-4-5-20250929[1m]')
    ).toBe(1000000);
  });

  it('returns 1M for bare opus/sonnet (they resolve server-side to 4.6+)', () => {
    expect(getProviderModelContextWindow('claude', CLAUDE_MODELS.OPUS)).toBe(1000000);
    expect(getProviderModelContextWindow('claude', CLAUDE_MODELS.SONNET)).toBe(1000000);
  });

  it('returns 200k for pinned older Claude models', () => {
    expect(getProviderModelContextWindow('claude-cli', 'claude-opus-4-5')).toBe(200000);
    expect(getProviderModelContextWindow('claude', CLAUDE_MODELS.HAIKU)).toBe(200000);
  });

  it('returns 1M for 4.6+ models that natively support it', () => {
    expect(getProviderModelContextWindow('claude', 'claude-opus-4-6')).toBe(1000000);
    expect(getProviderModelContextWindow('claude-cli', 'claude-sonnet-4-6')).toBe(1000000);
  });

  it('returns 1M when Claude provider model is undefined or empty', () => {
    expect(getProviderModelContextWindow('claude-cli', undefined)).toBe(1000000);
    expect(getProviderModelContextWindow('claude', '')).toBe(1000000);
  });

  it('returns 200k for non-Claude providers', () => {
    expect(getProviderModelContextWindow('codex', 'gpt-5.5')).toBe(200000);
  });
});

describe('provider model lists', () => {
  it('exposes Claude 1M variants in the static Claude model list', () => {
    const claudeModels = PROVIDER_MODEL_LIST['claude'].map((model) => model.id);

    expect(claudeModels).toContain(CLAUDE_MODELS.SONNET_1M);
    expect(claudeModels).toContain(CLAUDE_MODELS.OPUS_1M);
  });

  it('exposes Gemini models through the Copilot fallback model list', () => {
    const copilotModels = PROVIDER_MODEL_LIST['copilot'].map((model) => model.id);

    expect(copilotModels).toContain(COPILOT_MODELS.GEMINI_3_1_PRO);
    expect(copilotModels).toContain(COPILOT_MODELS.GEMINI_25_PRO);
  });

  it('uses Gemini 3.1 Pro as the default Copilot model', () => {
    expect(DEFAULT_MODELS.copilot).toBe(COPILOT_MODELS.GEMINI_3_1_PRO);
    expect(getPrimaryModelForProvider('copilot')).toBe(COPILOT_MODELS.GEMINI_3_1_PRO);
  });
});

describe('model alias normalization', () => {
  it('normalizes human-readable Copilot model names to canonical IDs', () => {
    expect(normalizeModelAliasForProvider('copilot', 'Gemini 3.1 Pro')).toBe(
      COPILOT_MODELS.GEMINI_3_1_PRO
    );
    expect(normalizeModelForProvider('copilot', 'gemini 3.1 pro')).toBe(
      COPILOT_MODELS.GEMINI_3_1_PRO
    );
  });

  it('preserves unknown dynamic Copilot model IDs', () => {
    expect(normalizeModelForProvider('copilot', 'grok-4-next')).toBe('grok-4-next');
  });
});
