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

    it('handles circular references without recursing forever', () => {
      const node: { text: string; self?: unknown; items?: unknown[] } = { text: 'a\uD800b' };
      node.self = node;
      node.items = [node];

      const sanitized = sanitizeProviderText(node);
      expect(sanitized.text).toBe('ab');
      expect(sanitized.self).toBe(sanitized);
      expect(sanitized.items?.[0]).toBe(sanitized);
    });

    it('preserves the shape of a string system prompt request byte-for-byte', () => {
      const request = {
        model: 'claude-test',
        max_tokens: 64,
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'hello' }],
      };

      expect(JSON.stringify(sanitizeProviderText(request))).toBe(JSON.stringify(request));
    });

    it('preserves the shape of a block-array system prompt request byte-for-byte', () => {
      const request = {
        model: 'claude-test',
        max_tokens: 64,
        system: [
          { type: 'text', text: 'cached preamble', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'tail' },
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      };

      expect(JSON.stringify(sanitizeProviderText(request))).toBe(JSON.stringify(request));
    });
  });
});
