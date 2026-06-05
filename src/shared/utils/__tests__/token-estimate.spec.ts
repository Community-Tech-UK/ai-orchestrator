import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_IMAGE_TOKEN_COST,
  estimateTokens,
} from '../token-estimate';

describe('token-estimate', () => {
  describe('estimateTokens', () => {
    it('returns 0 for empty or falsy input', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(undefined as unknown as string)).toBe(0);
      expect(estimateTokens(null as unknown as string)).toBe(0);
    });

    it('is byte-identical to Math.ceil(len / 4) for Latin text (behaviour-preserving)', () => {
      const samples = [
        'a',
        'abcd',
        'abcde',
        'hello world',
        'The quick brown fox jumps over the lazy dog.',
        'function estimateTokens(text) { return Math.ceil(text.length / 4); }',
        'x'.repeat(1000),
        'lorem ipsum '.repeat(137),
      ];
      for (const text of samples) {
        expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
      }
    });

    it('never under-counts a non-empty string (>= 1 token)', () => {
      expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
      expect(estimateTokens('你')).toBeGreaterThanOrEqual(1);
    });

    it('honours a custom charsPerToken ratio for the Latin path', () => {
      const text = 'x'.repeat(100);
      expect(estimateTokens(text, { charsPerToken: 5 })).toBe(20);
      expect(estimateTokens(text, { charsPerToken: 4 })).toBe(25);
      // Default matches the exported constant.
      expect(estimateTokens(text)).toBe(Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN));
    });

    it('counts CJK text more densely than the naive chars/4 heuristic', () => {
      // 100 Han characters: naive heuristic would say 25 tokens, which badly
      // under-counts. The CJK-aware estimate must be strictly larger.
      const han = '语'.repeat(100);
      const naive = Math.ceil(han.length / 4);
      const estimate = estimateTokens(han);
      expect(estimate).toBeGreaterThan(naive);
      expect(estimate).toBe(60); // 100 * 0.6 tokens/char
    });

    it('recognises Hiragana, Katakana, and Hangul as CJK', () => {
      for (const ch of ['ひ', 'カ', '한']) {
        const text = ch.repeat(50);
        expect(estimateTokens(text)).toBeGreaterThan(Math.ceil(text.length / 4));
      }
    });

    it('blends Latin and CJK characters in mixed content', () => {
      // 8 Latin chars (2 tokens) + 4 Han chars (2.4 -> ceil 3 combined)
      const mixed = 'abcdefgh语语语语';
      const expected = Math.max(1, Math.ceil(8 / 4 + 4 * 0.6));
      expect(estimateTokens(mixed)).toBe(expected);
    });

    it('can count JSON more densely when the caller identifies structured content', () => {
      const json = JSON.stringify({ tool: 'search', args: { query: 'token accounting', limit: 10 } });
      expect(estimateTokens(json, { contentKind: 'json' })).toBeGreaterThan(estimateTokens(json));
    });

    it('adds fixed image attachment cost even when there is no text', () => {
      expect(estimateTokens('', { imageCount: 2 })).toBe(DEFAULT_IMAGE_TOKEN_COST * 2);
      expect(estimateTokens('caption', { imageCount: 1 })).toBe(
        Math.ceil('caption'.length / DEFAULT_CHARS_PER_TOKEN) + DEFAULT_IMAGE_TOKEN_COST,
      );
    });
  });
});
