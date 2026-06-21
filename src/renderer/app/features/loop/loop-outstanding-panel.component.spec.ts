import { describe, expect, it } from 'vitest';
import { outstandingHasAnswer, outstandingUnsavedAnswer } from './loop-outstanding-panel.component';

/**
 * Tests for the pure answer-detection helpers behind the "Resume with answers (N)"
 * count. Regression guard for the bug where a typed-but-unsaved answer showed
 * "Resume with answers (0)" — the count must reflect a draft the user has typed
 * (it is flushed to the DB on resume), but NOT a pre-filled recommendation the
 * user hasn't touched.
 *
 * Not a TestBed/component test: the project's vitest config has no Angular
 * compiler plugin, so signal-based `input()` metadata isn't generated. Logic is
 * exposed as pure functions and tested directly (same pattern as
 * `deriveReattemptSeed`).
 */
describe('outstandingUnsavedAnswer', () => {
  it('returns undefined when there is no draft (just a persisted value or recommendation)', () => {
    expect(outstandingUnsavedAnswer(null, undefined)).toBeUndefined();
    expect(outstandingUnsavedAnswer('saved answer', undefined)).toBeUndefined();
  });

  it('returns the draft text when the user typed something new', () => {
    expect(outstandingUnsavedAnswer(null, 'my decision')).toBe('my decision');
    expect(outstandingUnsavedAnswer('', 'my decision')).toBe('my decision');
  });

  it('returns the edited draft when it differs from the persisted answer', () => {
    expect(outstandingUnsavedAnswer('old', 'new')).toBe('new');
  });

  it('returns undefined when the draft equals the persisted answer (no pending edit)', () => {
    expect(outstandingUnsavedAnswer('same', 'same')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only / cleared draft', () => {
    expect(outstandingUnsavedAnswer(null, '   ')).toBeUndefined();
    expect(outstandingUnsavedAnswer(null, '')).toBeUndefined();
  });
});

describe('outstandingHasAnswer', () => {
  it('counts a persisted answer', () => {
    expect(outstandingHasAnswer('saved', undefined)).toBe(true);
  });

  it('counts a typed-but-unsaved answer (the bug fix)', () => {
    expect(outstandingHasAnswer(null, 'typed but not saved')).toBe(true);
    expect(outstandingHasAnswer('', 'typed but not saved')).toBe(true);
  });

  it('does NOT count an item with no persisted answer and no draft', () => {
    expect(outstandingHasAnswer(null, undefined)).toBe(false);
    expect(outstandingHasAnswer('', undefined)).toBe(false);
  });

  it('does NOT count a whitespace-only persisted value or draft', () => {
    expect(outstandingHasAnswer('   ', undefined)).toBe(false);
    expect(outstandingHasAnswer(null, '   ')).toBe(false);
  });

  it('still counts a persisted answer even if the draft was cleared to match it', () => {
    // draft === persisted → no pending edit, but the persisted value still counts.
    expect(outstandingHasAnswer('keep me', 'keep me')).toBe(true);
  });
});
