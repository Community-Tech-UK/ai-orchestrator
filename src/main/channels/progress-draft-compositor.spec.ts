import { describe, it, expect } from 'vitest';
import {
  composeProgressDraftText,
  composeProgressDraftReceipt,
  shouldCreateProgressDraft,
  shouldEmitProgressDraftUpdate,
  formatElapsedDuration,
  DRAFT_CREATION_DELAY_MS,
  DRAFT_MIN_EDIT_INTERVAL_MS,
  DRAFT_MAX_LENGTH,
} from './progress-draft-compositor';

describe('progress-draft-compositor', () => {
  describe('formatElapsedDuration', () => {
    it('formats sub-minute durations as seconds', () => {
      expect(formatElapsedDuration(12_000)).toBe('12s');
      expect(formatElapsedDuration(0)).toBe('0s');
    });

    it('formats durations at or over a minute as "Nm Ss"', () => {
      expect(formatElapsedDuration(252_000)).toBe('4m 12s');
      expect(formatElapsedDuration(60_000)).toBe('1m 0s');
    });
  });

  describe('shouldCreateProgressDraft', () => {
    it('is false before the creation delay elapses (short-task skip)', () => {
      expect(shouldCreateProgressDraft(DRAFT_CREATION_DELAY_MS - 1)).toBe(false);
    });

    it('is true once the creation delay has elapsed', () => {
      expect(shouldCreateProgressDraft(DRAFT_CREATION_DELAY_MS)).toBe(true);
      expect(shouldCreateProgressDraft(DRAFT_CREATION_DELAY_MS + 5_000)).toBe(true);
    });
  });

  describe('composeProgressDraftText', () => {
    it('renders a stable header with no detail', () => {
      expect(composeProgressDraftText({ elapsedMs: 9_000 })).toBe('Working on it — 9s');
    });

    it('appends a detail line when present', () => {
      const text = composeProgressDraftText({ elapsedMs: 30_000, detail: 'Running Bash…' });
      expect(text).toBe('Working on it — 30s\nRunning Bash…');
    });

    it('redacts secret-shaped detail via the shared egress gate', () => {
      const secretLine = 'token=ghp_1234567890abcdefghij1234567890abcdef';
      const text = composeProgressDraftText({ elapsedMs: 9_000, detail: secretLine });
      expect(text).not.toContain('ghp_1234567890abcdefghij1234567890abcdef');
      expect(text).toContain('REDACTED');
    });

    it('bounds the composed length', () => {
      const longDetail = 'x'.repeat(DRAFT_MAX_LENGTH * 2);
      const text = composeProgressDraftText({ elapsedMs: 9_000, detail: longDetail });
      expect(text.length).toBeLessThanOrEqual(DRAFT_MAX_LENGTH);
    });

    it('falls back to a bare header when the detail redacts to nothing but whitespace', () => {
      const text = composeProgressDraftText({ elapsedMs: 9_000, detail: '   ' });
      expect(text).toBe('Working on it — 9s');
    });
  });

  describe('composeProgressDraftReceipt', () => {
    it('renders a calm success receipt', () => {
      expect(composeProgressDraftReceipt(252_000, 'success')).toBe('Done in 4m 12s — details follow');
    });

    it('renders a distinct failure receipt', () => {
      expect(composeProgressDraftReceipt(9_000, 'failure')).toBe('Hit a problem after 9s — details follow');
    });
  });

  describe('shouldEmitProgressDraftUpdate', () => {
    it('always emits the first update (no previous state)', () => {
      expect(shouldEmitProgressDraftUpdate(undefined, 'Working on it — 9s', 0)).toBe(true);
    });

    it('skips when the content is unchanged, even after the interval elapses', () => {
      const previous = { content: 'same', editedAt: 0 };
      expect(
        shouldEmitProgressDraftUpdate(previous, 'same', DRAFT_MIN_EDIT_INTERVAL_MS + 1_000),
      ).toBe(false);
    });

    it('skips a changed candidate before the minimum interval has passed', () => {
      const previous = { content: 'old', editedAt: 0 };
      expect(
        shouldEmitProgressDraftUpdate(previous, 'new', DRAFT_MIN_EDIT_INTERVAL_MS - 1),
      ).toBe(false);
    });

    it('emits a changed candidate once the minimum interval has passed', () => {
      const previous = { content: 'old', editedAt: 0 };
      expect(
        shouldEmitProgressDraftUpdate(previous, 'new', DRAFT_MIN_EDIT_INTERVAL_MS),
      ).toBe(true);
    });
  });
});
