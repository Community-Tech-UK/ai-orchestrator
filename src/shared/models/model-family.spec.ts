import { describe, expect, it } from 'vitest';
import { modelFamily, normalizeModelId, sameFamily } from './model-family';

/**
 * The roster below is the real one returned by the EBRD enterprise Copilot
 * seat's API (`"The requested model is not available for integrator
 * 'copilot-developer-cli'. Available models: [...]"`). Classifying every entry
 * is the whole point of this module: the checking policy picks a model from a
 * DIFFERENT family on that same seat, so an id that falls through to 'unknown'
 * silently drops out of the candidate pool.
 */
const ENTERPRISE_SEAT_ROSTER: readonly (readonly [string, string])[] = [
  ['claude-fable-5', 'anthropic'],
  ['claude-opus-4.7', 'anthropic'],
  ['claude-opus-4.8-fast', 'anthropic'],
  ['claude-opus-4.8', 'anthropic'],
  ['claude-opus-5', 'anthropic'],
  ['claude-sonnet-5', 'anthropic'],
  ['claude-sonnet-4.5', 'anthropic'],
  ['claude-opus-4.5', 'anthropic'],
  ['claude-haiku-4.5', 'anthropic'],
  ['gpt-4.1', 'openai'],
  ['gpt-5.3-codex', 'openai'],
  ['gpt-5.4-mini', 'openai'],
  ['gpt-5.4', 'openai'],
  ['gpt-5.5', 'openai'],
  ['gpt-5.6-luna', 'openai'],
  ['gpt-5.6-sol', 'openai'],
  ['gpt-5.6-terra', 'openai'],
  ['gemini-3.5-flash', 'google'],
  ['gemini-3.6-flash', 'google'],
  ['gemini-3.7-flash', 'google'],
  ['grok-4.5', 'xai'],
  ['grok-4.6', 'xai'],
  ['kimi-k2.7-code', 'moonshot'],
  ['kimi-k3', 'moonshot'],
  ['mai-code-1.1-flash', 'microsoft'],
  ['mai-code-1-flash-picker', 'microsoft'],
];

describe('modelFamily', () => {
  it.each(ENTERPRISE_SEAT_ROSTER)('classifies %s as %s', (id, expected) => {
    expect(modelFamily(id)).toBe(expected);
  });

  it('classifies the bare Claude CLI aliases', () => {
    expect(modelFamily('opus')).toBe('anthropic');
    expect(modelFamily('sonnet')).toBe('anthropic');
    expect(modelFamily('haiku')).toBe('anthropic');
  });

  it('strips a context-window suffix before matching', () => {
    expect(modelFamily('opus[1m]')).toBe('anthropic');
    expect(modelFamily('claude-opus-5[1m]')).toBe('anthropic');
  });

  it('classifies pinned hyphenated Claude ids as well as Copilot dotted ids', () => {
    // The Claude CLI pins `claude-opus-4-8`; Copilot serves `claude-opus-4.8`.
    expect(modelFamily('claude-opus-4-8')).toBe('anthropic');
    expect(modelFamily('claude-opus-4.8')).toBe('anthropic');
  });

  it('classifies display-name forms held in reviewer-model settings', () => {
    // `crossModelReviewModelByProvider.antigravity` really does hold this.
    expect(modelFamily('Gemini 3.5 Flash (Medium)')).toBe('google');
    expect(modelFamily('GPT-5.6 Terra')).toBe('openai');
  });

  it('classifies a cursor-style suffixed grok id', () => {
    expect(modelFamily('grok-4.5-xhigh')).toBe('xai');
  });

  it('treats auto and default as unknown rather than guessing', () => {
    expect(modelFamily('auto')).toBe('unknown');
    expect(modelFamily('default')).toBe('unknown');
  });

  it('returns unknown for empty, nullish and unrecognised ids', () => {
    expect(modelFamily(undefined)).toBe('unknown');
    expect(modelFamily(null)).toBe('unknown');
    expect(modelFamily('')).toBe('unknown');
    expect(modelFamily('   ')).toBe('unknown');
    expect(modelFamily('some-local-selector-id')).toBe('unknown');
  });
});

describe('sameFamily', () => {
  it('is true only for two positively-identified ids from one vendor', () => {
    expect(sameFamily('claude-opus-5', 'claude-sonnet-5')).toBe(true);
    expect(sameFamily('gpt-5.6-terra', 'gpt-5.3-codex')).toBe(true);
    expect(sameFamily('opus', 'claude-opus-4.8')).toBe(true);
  });

  it('is false across vendors', () => {
    expect(sameFamily('claude-opus-5', 'gpt-5.6-terra')).toBe(false);
    expect(sameFamily('gemini-3.7-flash', 'grok-4.6')).toBe(false);
  });

  it('is false when either side is unknown, so a guess never bars a checker', () => {
    expect(sameFamily('claude-opus-5', 'auto')).toBe(false);
    expect(sameFamily('auto', 'claude-opus-5')).toBe(false);
    expect(sameFamily(undefined, 'gpt-5.5')).toBe(false);
    expect(sameFamily('unknown-a', 'unknown-b')).toBe(false);
  });
});

describe('normalizeModelId', () => {
  it('lowercases, strips the context suffix and folds separators', () => {
    expect(normalizeModelId('  Claude Opus 5[1m] ')).toBe('claude-opus-5');
    expect(normalizeModelId('GPT_5.6_TERRA')).toBe('gpt-5.6-terra');
  });
});
