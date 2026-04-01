import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODELS,
  PROVIDER_MODEL_LIST,
  getProviderModelContextWindow,
} from './provider.types';

describe('provider type helpers', () => {
  it('returns 1M context for explicit Claude 1M variants', () => {
    expect(getProviderModelContextWindow('claude', CLAUDE_MODELS.SONNET_1M)).toBe(1000000);
    expect(getProviderModelContextWindow('claude-cli', CLAUDE_MODELS.OPUS_1M)).toBe(1000000);
    expect(
      getProviderModelContextWindow('anthropic-api', 'claude-sonnet-4-5-20250929[1m]')
    ).toBe(1000000);
  });

  it('returns 200k default for bare Claude model names (1M requires [1m] suffix or 4.6+)', () => {
    expect(getProviderModelContextWindow('claude', CLAUDE_MODELS.OPUS)).toBe(200000);
    expect(getProviderModelContextWindow('claude-cli', 'claude-opus-4-5')).toBe(200000);
    expect(getProviderModelContextWindow('claude', CLAUDE_MODELS.SONNET)).toBe(200000);
  });

  it('returns 1M for 4.6+ models that natively support it', () => {
    expect(getProviderModelContextWindow('claude', 'claude-opus-4-6')).toBe(1000000);
    expect(getProviderModelContextWindow('claude-cli', 'claude-sonnet-4-6')).toBe(1000000);
  });

  it('returns 200k for non-Claude providers', () => {
    expect(getProviderModelContextWindow('codex', 'gpt-5.4')).toBe(200000);
  });
});

describe('provider model lists', () => {
  it('exposes Claude 1M variants in the static Claude model list', () => {
    const claudeModels = PROVIDER_MODEL_LIST['claude'].map((model) => model.id);

    expect(claudeModels).toContain(CLAUDE_MODELS.SONNET_1M);
    expect(claudeModels).toContain(CLAUDE_MODELS.OPUS_1M);
  });
});
