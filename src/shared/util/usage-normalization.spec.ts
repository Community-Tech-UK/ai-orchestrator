/**
 * Provider-payload fixture tests for the token-usage normalization contract
 * (A5). `normalizeUsage` is the single entry point that 15+ provider field
 * conventions funnel through before cost tracking and the context ring consume
 * them, so this locks the contract against silent regression with realistic
 * provider payloads plus the validity / precedence edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeUsage,
  derivePromptTokens,
  deriveSessionTotalTokens,
  type NormalizedUsage,
  type UsageLike,
} from './usage-normalization';

describe('normalizeUsage', () => {
  describe('realistic provider payloads', () => {
    it('normalizes an Anthropic snake_case streaming usage payload', () => {
      // Shape emitted by the Anthropic SDK on message_delta / message_start.
      const payload: UsageLike = {
        input_tokens: 1024,
        output_tokens: 256,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 120,
      };
      expect(normalizeUsage(payload)).toEqual({
        input: 1024,
        output: 256,
        cacheRead: 800,
        cacheWrite: 120,
      });
    });

    it('normalizes an Anthropic camelCase payload', () => {
      const payload: UsageLike = { inputTokens: 500, outputTokens: 90 };
      expect(normalizeUsage(payload)).toEqual({ input: 500, output: 90 });
    });

    it('normalizes an OpenAI snake_case payload (with total)', () => {
      const payload: UsageLike = {
        prompt_tokens: 200,
        completion_tokens: 80,
        total_tokens: 280,
      };
      expect(normalizeUsage(payload)).toEqual({ input: 200, output: 80, total: 280 });
    });

    it('normalizes an OpenAI camelCase payload', () => {
      const payload: UsageLike = {
        promptTokens: 200,
        completionTokens: 80,
        totalTokens: 280,
      };
      expect(normalizeUsage(payload)).toEqual({ input: 200, output: 80, total: 280 });
    });

    it('passes a canonical payload through unchanged', () => {
      const payload: UsageLike = {
        input: 10,
        output: 20,
        cacheRead: 5,
        cacheWrite: 2,
        total: 37,
      };
      expect(normalizeUsage(payload)).toEqual({
        input: 10,
        output: 20,
        cacheRead: 5,
        cacheWrite: 2,
        total: 37,
      });
    });
  });

  describe('cache-field naming conventions', () => {
    it.each<[string, UsageLike, NormalizedUsage]>([
      ['cache_read / cache_write', { cache_read: 3, cache_write: 4 }, { cacheRead: 3, cacheWrite: 4 }],
      ['cacheReadTokens / cacheWriteTokens', { cacheReadTokens: 3, cacheWriteTokens: 4 }, { cacheRead: 3, cacheWrite: 4 }],
      ['cache_read_tokens / cache_write_tokens', { cache_read_tokens: 3, cache_write_tokens: 4 }, { cacheRead: 3, cacheWrite: 4 }],
      ['anthropic cache_*_input_tokens', { cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, { cacheRead: 3, cacheWrite: 4 }],
    ])('resolves %s', (_label, payload, expected) => {
      expect(normalizeUsage(payload)).toEqual(expected);
    });
  });

  describe('total naming conventions', () => {
    it.each<[string, UsageLike]>([
      ['total', { total: 99 }],
      ['totalTokens', { totalTokens: 99 }],
      ['total_tokens', { total_tokens: 99 }],
    ])('resolves %s', (_label, payload) => {
      expect(normalizeUsage(payload)).toEqual({ total: 99 });
    });
  });

  describe('precedence (first DEFINED value wins per the ?? chain)', () => {
    it('prefers the canonical field over snake/camel aliases', () => {
      const payload: UsageLike = { input: 5, inputTokens: 50, input_tokens: 500 };
      expect(normalizeUsage(payload)?.input).toBe(5);
    });

    it('prefers camelCase over snake_case when canonical is absent', () => {
      const payload: UsageLike = { inputTokens: 50, input_tokens: 500 };
      expect(normalizeUsage(payload)?.input).toBe(50);
    });

    it('falls through null/undefined higher-precedence fields to a valid alias', () => {
      // null/undefined ARE nullish, so the ?? chain continues to the next field.
      const payload = { input: null, input_tokens: 42 } as unknown as UsageLike;
      expect(normalizeUsage(payload)?.input).toBe(42);
    });
  });

  describe('validity filtering', () => {
    it('keeps a zero value (0 is finite and non-negative)', () => {
      expect(normalizeUsage({ input_tokens: 0, output_tokens: 5 })).toEqual({ input: 0, output: 5 });
    });

    it.each<[string, number]>([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['negative', -10],
    ])('drops a single field whose only value is %s', (_label, bad) => {
      const result = normalizeUsage({ input_tokens: bad, output_tokens: 5 });
      expect(result).toEqual({ output: 5 });
      expect(result && 'input' in result).toBe(false);
    });

    it('drops non-number values supplied via the index signature', () => {
      const payload = { input_tokens: '100' as unknown as number, output_tokens: 5 };
      expect(normalizeUsage(payload)).toEqual({ output: 5 });
    });

    it('documents the conservative edge: an invalid HIGHER-precedence field masks a valid alias', () => {
      // The ?? chain short-circuits on the first *defined* value; a present-but-
      // invalid canonical field is therefore dropped rather than falling through.
      // Safe (undefined beats wrong), and unreachable in practice since canonical
      // fields are our own internal names, never present on a raw provider payload.
      const payload: UsageLike = { input: Number.NaN, input_tokens: 100 };
      expect(normalizeUsage(payload)?.input).toBeUndefined();
    });
  });

  describe('absent / empty inputs', () => {
    it('returns undefined for null', () => {
      expect(normalizeUsage(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(normalizeUsage(undefined)).toBeUndefined();
    });

    it('returns undefined for an empty object', () => {
      expect(normalizeUsage({})).toBeUndefined();
    });

    it('returns undefined when only unrecognized fields are present', () => {
      expect(normalizeUsage({ somethingElse: 5, duration: 1200 } as UsageLike)).toBeUndefined();
    });

    it('returns undefined (not an empty object) when every token field is invalid', () => {
      expect(normalizeUsage({ input_tokens: -1, output_tokens: Number.NaN })).toBeUndefined();
    });
  });
});

describe('derivePromptTokens', () => {
  it('sums input + cacheRead + cacheWrite', () => {
    expect(derivePromptTokens({ input: 100, cacheRead: 20, cacheWrite: 5 })).toBe(125);
  });

  it('treats absent fields as zero', () => {
    expect(derivePromptTokens({ input: 100 })).toBe(100);
    expect(derivePromptTokens({ cacheRead: 20 })).toBe(20);
    expect(derivePromptTokens({})).toBe(0);
  });

  it('reflects the full prompt cost including cached tokens', () => {
    const usage = normalizeUsage({
      input_tokens: 50,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    });
    expect(usage).toBeDefined();
    expect(derivePromptTokens(usage as NormalizedUsage)).toBe(950);
  });
});

describe('deriveSessionTotalTokens', () => {
  it('adds output to the prompt-token total', () => {
    expect(deriveSessionTotalTokens({ input: 100, cacheRead: 20, output: 30 })).toBe(150);
  });

  it('treats absent output as zero', () => {
    expect(deriveSessionTotalTokens({ input: 100 })).toBe(100);
  });

  it('returns 0 for an empty usage object', () => {
    expect(deriveSessionTotalTokens({})).toBe(0);
  });

  it('does NOT clamp to any window size (pure sum)', () => {
    expect(deriveSessionTotalTokens({ input: 1_000_000, output: 500_000 })).toBe(1_500_000);
  });
});
