import { describe, expect, it } from 'vitest';

import {
  compareVersion,
  formatOpusName,
  opusVersion,
  pickNewest,
} from '../generate-cursor-models.versions';

/**
 * These cover the slot-selection logic behind the curated Cursor fallback list
 * in `PROVIDER_MODEL_LIST.cursor`. The generator is fail-soft and prints
 * "up to date" when nothing changes, so a parse gap here is silent — it just
 * keeps pinning last generation's model forever.
 */
describe('generate-cursor-models version helpers', () => {
  describe('opusVersion', () => {
    it('parses the major-minor id shape', () => {
      expect(opusVersion('claude-opus-4-8-thinking-high')).toEqual([4, 8]);
      expect(opusVersion('claude-opus-4-6-thinking-high')).toEqual([4, 6]);
    });

    // Regression: the original regex required a minor segment
    // (/opus-(\d+)-(\d+)/), so every `claude-opus-5-*` id returned null, was
    // filtered out of the candidate set, and the generator kept selecting
    // Opus 4.8 while reporting "up to date".
    it('parses the major-only id shape introduced by the 5 generation', () => {
      expect(opusVersion('claude-opus-5-thinking-high')).toEqual([5]);
      expect(opusVersion('claude-opus-5-high')).toEqual([5]);
    });

    it('parses a future major-minor id in the 5 generation', () => {
      expect(opusVersion('claude-opus-5-1-thinking-high')).toEqual([5, 1]);
    });

    it('parses the legacy dotted shape', () => {
      expect(opusVersion('claude-4.6-opus-thinking-high')).toEqual([4, 6]);
    });

    it('returns null for non-Opus ids', () => {
      expect(opusVersion('gpt-5.5-high')).toBeNull();
      expect(opusVersion('composer-2.5')).toBeNull();
    });
  });

  describe('compareVersion', () => {
    it('ranks a major-only 5 above a major-minor 4.8', () => {
      expect(compareVersion([5], [4, 8])).toBeGreaterThan(0);
      expect(compareVersion([4, 8], [5])).toBeLessThan(0);
    });

    it('treats a missing minor segment as zero', () => {
      expect(compareVersion([5], [5, 1])).toBeLessThan(0);
      expect(compareVersion([5], [5, 0])).toBe(0);
    });
  });

  describe('pickNewest', () => {
    it('selects Opus 5 over Opus 4.8 regardless of list order', () => {
      const ids = ['claude-opus-4-8-thinking-high', 'claude-opus-5-thinking-high'];

      expect(pickNewest(ids, opusVersion)).toBe('claude-opus-5-thinking-high');
      expect(pickNewest([...ids].reverse(), opusVersion)).toBe(
        'claude-opus-5-thinking-high',
      );
    });

    it('keeps the first-seen id on a tie', () => {
      const ids = ['claude-opus-5-thinking-high', 'claude-opus-5-thinking-xhigh'];

      expect(pickNewest(ids, opusVersion)).toBe('claude-opus-5-thinking-high');
    });

    it('returns null when nothing parses', () => {
      expect(pickNewest(['composer-2.5'], opusVersion)).toBeNull();
    });
  });

  describe('formatOpusName', () => {
    it('renders a major-only version without a trailing ".undefined"', () => {
      expect(formatOpusName([5])).toBe('Opus 5');
    });

    it('renders a major-minor version', () => {
      expect(formatOpusName([4, 8])).toBe('Opus 4.8');
    });
  });
});
