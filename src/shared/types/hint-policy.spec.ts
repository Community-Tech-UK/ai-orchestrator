import { describe, expect, it } from 'vitest';

import { HINTS, shouldShowHint, withDismissed, type HintId } from './hint-policy';

describe('shouldShowHint (UX5)', () => {
  it('shows a relevant, undismissed hint', () => {
    expect(shouldShowHint({
      id: 'loop-config-first-open', dismissed: [], condition: true,
    })).toEqual({ show: true });
  });

  /** Dismissed means gone for good; a hint that returns is an advert. */
  it('never returns after dismissal', () => {
    expect(shouldShowHint({
      id: 'loop-config-first-open', dismissed: ['loop-config-first-open'], condition: true,
    })).toEqual({ show: false, reason: 'dismissed' });
  });

  /**
   * Not-yet-relevant is different from dismissed: the hint stays eligible, so
   * it can appear later when the behaviour actually earns it.
   */
  it('withholds a hint whose moment has not arrived, without burning it', () => {
    const decision = shouldShowHint({
      id: 'settings-overview-profiles', dismissed: [], condition: false,
    });
    expect(decision).toEqual({ show: false, reason: 'condition-not-met' });
    expect(shouldShowHint({
      id: 'settings-overview-profiles', dismissed: [], condition: true,
    }).show).toBe(true);
  });

  it('refuses an unknown id rather than rendering an empty box', () => {
    expect(shouldShowHint({
      id: 'not-a-hint' as HintId, dismissed: [], condition: true,
    })).toEqual({ show: false, reason: 'unknown-hint' });
  });
});

describe('withDismissed', () => {
  it('records a dismissal', () => {
    expect(withDismissed([], 'loop-config-first-open')).toEqual(['loop-config-first-open']);
  });

  /** Dismissing twice should not cost a settings round trip. */
  it('returns the same reference when already dismissed', () => {
    const existing = ['loop-config-first-open'];
    expect(withDismissed(existing, 'loop-config-first-open')).toBe(existing);
  });

  it('keeps earlier dismissals', () => {
    expect(withDismissed(['a'], 'settings-overview-profiles'))
      .toEqual(['a', 'settings-overview-profiles']);
  });
});

describe('hint copy', () => {
  it('every hint says something specific enough to be worth the space', () => {
    for (const [id, copy] of Object.entries(HINTS)) {
      expect(copy.id, id).toBe(id);
      expect(copy.title.length, id).toBeGreaterThan(10);
      expect(copy.body.length, id).toBeGreaterThan(40);
    }
  });
});
