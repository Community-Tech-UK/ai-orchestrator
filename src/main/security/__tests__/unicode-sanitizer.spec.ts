import { describe, expect, it } from 'vitest';
import { sanitizeUnicode, containsDangerousUnicode } from '../unicode-sanitizer';

describe('UnicodeSanitizer', () => {
  describe('containsDangerousUnicode', () => {
    it('returns false for plain ASCII text', () => {
      expect(containsDangerousUnicode('Hello, world!')).toBe(false);
    });

    it('detects zero-width spaces', () => {
      expect(containsDangerousUnicode('Hello\u200Bworld')).toBe(true);
    });

    it('detects zero-width joiners', () => {
      expect(containsDangerousUnicode('test\u200Dvalue')).toBe(true);
    });

    it('detects zero-width non-joiners', () => {
      expect(containsDangerousUnicode('test\u200Cvalue')).toBe(true);
    });

    it('detects direction override characters', () => {
      expect(containsDangerousUnicode('admin\u202Etest')).toBe(true);
    });

    it('detects Tag characters (U+E0001-U+E007F)', () => {
      expect(containsDangerousUnicode('text\u{E0001}injected')).toBe(true);
    });

    it('detects BOM', () => {
      expect(containsDangerousUnicode('\uFEFFhello')).toBe(true);
    });

    it('allows safe non-ASCII (accents, CJK, emoji)', () => {
      expect(containsDangerousUnicode('cafe resume')).toBe(false);
      expect(containsDangerousUnicode('test emoji')).toBe(false);
    });
  });

  describe('sanitizeUnicode', () => {
    it('returns clean text unchanged', () => {
      expect(sanitizeUnicode('Hello, world!')).toBe('Hello, world!');
    });

    it('strips zero-width characters', () => {
      expect(sanitizeUnicode('He\u200Bllo\u200Cwo\u200Drld')).toBe('Helloworld');
    });

    it('strips direction overrides', () => {
      expect(sanitizeUnicode('admin\u202Etest')).toBe('admintest');
    });

    it('strips Tag characters', () => {
      expect(sanitizeUnicode('text\u{E0001}\u{E0068}\u{E0065}end')).toBe('textend');
    });

    it('strips BOM', () => {
      expect(sanitizeUnicode('\uFEFFhello')).toBe('hello');
    });

    it('applies NFKC normalization', () => {
      expect(sanitizeUnicode('\uFB01le')).toBe('file');
    });

    it('handles iterative stripping (nested dangerous chars)', () => {
      const input = 'a\u200B\u200Cb';
      expect(sanitizeUnicode(input)).toBe('ab');
    });

    it('preserves newlines, tabs, and normal whitespace', () => {
      expect(sanitizeUnicode('line1\nline2\ttab')).toBe('line1\nline2\ttab');
    });

    it('handles empty string', () => {
      expect(sanitizeUnicode('')).toBe('');
    });
  });
});
