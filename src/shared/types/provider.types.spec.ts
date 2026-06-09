import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODELS,
  CLAUDE_PINNED_MODELS,
  COPILOT_MODELS,
  DEFAULT_MODELS,
  MODEL_PRICING,
  PROVIDER_MODEL_LIST,
  REASONING_EFFORTS,
  getDefaultModelForCli,
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
    expect(getProviderModelContextWindow('claude', 'claude-opus-4-8')).toBe(1000000);
    expect(getProviderModelContextWindow('claude-cli', 'claude-sonnet-4-6')).toBe(1000000);
    expect(getProviderModelContextWindow('claude-cli', 'claude-fable-5')).toBe(1000000);
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
  it('defaults orchestration invocations to plain Opus; interactive sessions to Opus-1M', () => {
    // DEFAULT_MODELS feeds one-shot orchestration invocations (verify/review/
    // debate/workflow) via getDefaultModelForCli — plain Opus, no 1M premium.
    expect(DEFAULT_MODELS['claude-cli']).toBe(CLAUDE_MODELS.OPUS);
    expect(DEFAULT_MODELS['anthropic-api']).toBe(CLAUDE_MODELS.OPUS);
    expect(getDefaultModelForCli('claude')).toBe(CLAUDE_MODELS.OPUS);
    // Interactive new-session default keeps the 1M window (PROVIDER_MODEL_LIST[0]).
    expect(getPrimaryModelForProvider('claude')).toBe(CLAUDE_MODELS.OPUS_1M);
  });

  it('exposes Claude 1M variants in the static Claude model list', () => {
    const claudeModels = PROVIDER_MODEL_LIST['claude'].map((model) => model.id);

    expect(claudeModels).toContain(CLAUDE_MODELS.SONNET_1M);
    expect(claudeModels).toContain(CLAUDE_MODELS.OPUS_1M);
  });

  it('exposes Opus 4.8 as the latest pinned Claude generation', () => {
    const claudeModels = PROVIDER_MODEL_LIST['claude'].map((model) => model.id);

    expect(CLAUDE_PINNED_MODELS.OPUS_48).toBe('claude-opus-4-8');
    expect(claudeModels).toContain(CLAUDE_PINNED_MODELS.OPUS_48);
    expect(MODEL_PRICING[CLAUDE_PINNED_MODELS.OPUS_48]).toEqual({ input: 5.0, output: 25.0 });
  });

  it('exposes Claude Fable 5 as an explicit Claude model', () => {
    const claudeModels = PROVIDER_MODEL_LIST['claude'].map((model) => model.id);
    const pinned = CLAUDE_PINNED_MODELS as Record<string, string>;

    expect(pinned['FABLE_5']).toBe('claude-fable-5');
    expect(claudeModels).toContain('claude-fable-5');
    expect(MODEL_PRICING['claude-fable-5']).toEqual({ input: 10.0, output: 50.0 });
  });

  it('includes Claude Code session-only effort options in the shared reasoning set', () => {
    expect(REASONING_EFFORTS).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'workflow',
    ]);
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

  it('pins the primary default model for every provider that has a static list', () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODEL_LIST)) {
      if (models.length === 0) continue;
      const primary = getPrimaryModelForProvider(provider);
      const entry = models.find((m) => m.id === primary);
      expect(entry, `${provider} primary default ${String(primary)} should exist in PROVIDER_MODEL_LIST`).toBeDefined();
      expect(
        entry?.pinned,
        `${provider} primary default ${String(primary)} should be pinned: true so it surfaces in the compact picker's Latest section`,
      ).toBe(true);
    }
  });

  it('caps the pinned set at five entries per provider', () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODEL_LIST)) {
      const pinnedCount = models.filter((m) => m.pinned === true).length;
      expect(
        pinnedCount,
        `${provider} has ${pinnedCount} pinned entries; cap is 5 to keep the menu shallow`,
      ).toBeLessThanOrEqual(5);
    }
  });

  it('tags every static entry with a family for the Other versions submenu', () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODEL_LIST)) {
      if (models.length === 0) continue;
      for (const model of models) {
        expect(
          model.family,
          `${provider}/${model.id} must declare a family for Other versions sectioning`,
        ).toBeDefined();
      }
    }
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
