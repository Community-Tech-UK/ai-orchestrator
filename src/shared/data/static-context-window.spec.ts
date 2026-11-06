import { describe, expect, it } from 'vitest';
import { getStaticContextWindow } from './static-context-window';
import { CLAUDE_MODELS, GROK_MODELS, OPENAI_MODELS, PROVIDER_MODEL_LIST } from '../types/provider.types';

describe('getStaticContextWindow', () => {
  it('sizes Claude aliases: [1m] and the latest Opus/Sonnet at 1M, Haiku at 200K', () => {
    expect(getStaticContextWindow('claude', CLAUDE_MODELS.OPUS_1M)).toBe(1_000_000);
    expect(getStaticContextWindow('claude', CLAUDE_MODELS.SONNET_1M)).toBe(1_000_000);
    expect(getStaticContextWindow('claude', CLAUDE_MODELS.OPUS)).toBe(1_000_000);
    expect(getStaticContextWindow('claude', CLAUDE_MODELS.SONNET)).toBe(1_000_000);
    expect(getStaticContextWindow('claude', CLAUDE_MODELS.HAIKU)).toBe(200_000);
  });

  it('sizes Codex, Gemini and Grok from their own tables, and ignores provider case', () => {
    expect(getStaticContextWindow('codex', OPENAI_MODELS.GPT55)).toBe(200_000);
    expect(getStaticContextWindow('Gemini', 'gemini-2.5-pro')).toBe(1_000_000);
    expect(getStaticContextWindow('grok', GROK_MODELS.GROK_47)).toBe(500_000);
  });

  it('answers every default row of the four sized providers', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'grok']) {
      for (const m of PROVIDER_MODEL_LIST[provider] ?? []) {
        expect(getStaticContextWindow(provider, m.id), `${provider}:${m.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('returns undefined instead of guessing', () => {
    expect(getStaticContextWindow('copilot', 'auto')).toBeUndefined();
    expect(getStaticContextWindow('cursor', 'composer-2.5')).toBeUndefined();
    expect(getStaticContextWindow('gemini', 'gemini-not-in-the-list')).toBeUndefined();
    // A Claude id under the Gemini provider must not borrow another provider's row.
    expect(getStaticContextWindow('gemini', CLAUDE_MODELS.OPUS)).toBeUndefined();
  });
});
