import { describe, expect, it } from 'vitest';
import { sanitizeProviderText, stripLoneSurrogates } from '../surrogate-sanitizer';

describe('surrogate-sanitizer', () => {
  describe('stripLoneSurrogates', () => {
    it('removes lone high and low surrogates', () => {
      expect(stripLoneSurrogates('a\uD800b\uDC00c')).toBe('abc');
    });

    it('preserves valid surrogate pairs', () => {
      expect(stripLoneSurrogates('ok \uD83D\uDE00')).toBe('ok \uD83D\uDE00');
    });

    it('does not normalize or strip prompt-injection Unicode controls', () => {
      expect(stripLoneSurrogates('zero\u200Bwidth \uFB01le')).toBe('zero\u200Bwidth \uFB01le');
    });
  });

  describe('sanitizeProviderText', () => {
    it('recursively sanitizes strings in arrays and plain objects', () => {
      const input = {
        prompt: 'a\uD800b',
        nested: [{ text: '\uDC00c' }],
        keep: 12,
      };

      expect(sanitizeProviderText(input)).toEqual({
        prompt: 'ab',
        nested: [{ text: 'c' }],
        keep: 12,
      });
    });

    it('leaves non-plain objects unchanged', () => {
      const date = new Date('2026-07-01T00:00:00.000Z');
      expect(sanitizeProviderText(date)).toBe(date);
    });
  });
});
