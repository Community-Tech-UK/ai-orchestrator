import { describe, expect, it } from 'vitest';
import {
  DENSE_TOOLTIP_DELAY_MS,
  isRedundantWithLabel,
  mergeDescribedBy,
  openDelayFor,
  OVERFLOW_TOOLTIP_DELAY_MS,
  resolveIconButtonAria,
  shouldOpenOnFocus,
  shouldSuppressTooltip,
  TOOLTIP_DELAY_MS,
  unmergeDescribedBy,
} from './tooltip-policy';

describe('openDelayFor (UX1)', () => {
  it('uses the icon-rail delay by default', () => {
    expect(openDelayFor('default', false)).toBe(TOOLTIP_DELAY_MS);
  });

  it('waits longer for a tooltip that only restates a truncated label', () => {
    expect(openDelayFor('overflow', false)).toBe(OVERFLOW_TOOLTIP_DELAY_MS);
  });

  it('waits longest inside a dense metric strip the user reads as a whole', () => {
    expect(openDelayFor('dense', false)).toBe(DENSE_TOOLTIP_DELAY_MS);
  });

  // Moving along a rail should not re-pay the delay at every icon.
  it('opens immediately while the skip window is active', () => {
    expect(openDelayFor('default', true)).toBe(0);
    expect(openDelayFor('dense', true)).toBe(0);
  });

  // The negative lesson: a 0ms default flashes a trail of boxes across a rail.
  it('never defaults to zero', () => {
    for (const variant of ['default', 'overflow', 'dense'] as const) {
      expect(openDelayFor(variant, false)).toBeGreaterThan(0);
    }
  });
});

describe('shouldSuppressTooltip (UX1)', () => {
  it('shows an ordinary tooltip', () => {
    expect(shouldSuppressTooltip({ text: 'Pause the loop' })).toBe(false);
  });

  it('suppresses empty or whitespace-only copy', () => {
    expect(shouldSuppressTooltip({ text: '' })).toBe(true);
    expect(shouldSuppressTooltip({ text: '   ' })).toBe(true);
    expect(shouldSuppressTooltip({ text: null })).toBe(true);
    expect(shouldSuppressTooltip({ text: undefined })).toBe(true);
  });

  it('respects an explicit disable', () => {
    expect(shouldSuppressTooltip({ text: 'Pause', disabled: true })).toBe(true);
  });

  // An open menu already tells the user more than the tooltip would.
  it('suppresses while the trigger has an open menu', () => {
    expect(shouldSuppressTooltip({ text: 'Options', expanded: true })).toBe(true);
  });

  it('suppresses just after a click, so the tooltip does not cover what you pressed', () => {
    expect(shouldSuppressTooltip({ text: 'Pause', recentlyClicked: true })).toBe(true);
  });

  // Repeating a label the user can already read is noise, and gives screen
  // readers a duplicate accessible name.
  it('suppresses copy that merely repeats a fully visible label', () => {
    expect(shouldSuppressTooltip({ text: 'Pause', visibleLabel: 'Pause' })).toBe(true);
    expect(shouldSuppressTooltip({ text: 'Pause', visibleLabel: '  pause  ' })).toBe(true);
  });

  it('still shows when the visible label is truncated', () => {
    expect(shouldSuppressTooltip({
      text: 'A very long branch name',
      visibleLabel: 'A very long branch name',
      truncated: true,
    })).toBe(false);
  });

  it('shows when the copy says more than the label', () => {
    expect(shouldSuppressTooltip({ text: 'Stops after this iteration', visibleLabel: 'Pause' })).toBe(false);
  });
});

describe('isRedundantWithLabel (UX1)', () => {
  it('ignores case and collapsed whitespace', () => {
    expect(isRedundantWithLabel('Run  verify', 'run verify')).toBe(true);
  });

  it('is false when there is no visible label to compare against', () => {
    expect(isRedundantWithLabel('Run verify', null)).toBe(false);
    expect(isRedundantWithLabel('Run verify', '   ')).toBe(false);
  });
});

describe('shouldOpenOnFocus (UX1)', () => {
  it('opens for keyboard focus', () => {
    expect(shouldOpenOnFocus({ matches: (selector) => selector === ':focus-visible' })).toBe(true);
  });

  // Otherwise every button press leaves a tooltip over the thing you pressed.
  it('does not open for a click that incidentally focuses', () => {
    expect(shouldOpenOnFocus({ matches: () => false })).toBe(false);
  });

  it('fails closed when the engine does not understand :focus-visible', () => {
    expect(shouldOpenOnFocus({ matches: () => { throw new Error('bad selector'); } })).toBe(false);
  });
});

describe('resolveIconButtonAria (UX1)', () => {
  // Two different strings would tell sighted and screen-reader users different
  // things about the same control.
  it('gives the icon button one string for both the tooltip and the label', () => {
    expect(resolveIconButtonAria('  Terminate instance  ')).toEqual({
      ariaLabel: 'Terminate instance',
      tooltip: 'Terminate instance',
    });
  });
});

describe('aria-describedby merge and restore (UX1)', () => {
  it('adds the tooltip id alongside existing descriptions', () => {
    expect(mergeDescribedBy('hint-1 hint-2', 'tip-9')).toBe('hint-1 hint-2 tip-9');
  });

  it('does not duplicate an id already present', () => {
    expect(mergeDescribedBy('tip-9', 'tip-9')).toBe('tip-9');
  });

  it('handles a trigger with no prior description', () => {
    expect(mergeDescribedBy(null, 'tip-9')).toBe('tip-9');
  });

  // The reason merge/restore exists: a trigger that already owned a description
  // must still own it after the tooltip closes.
  it('restores exactly what was there before', () => {
    const before = 'hint-1 hint-2';
    const during = mergeDescribedBy(before, 'tip-9');
    expect(unmergeDescribedBy(during, 'tip-9')).toBe(before);
  });

  it('removes the attribute entirely when nothing else remains', () => {
    expect(unmergeDescribedBy(mergeDescribedBy(null, 'tip-9'), 'tip-9')).toBeNull();
  });
});
