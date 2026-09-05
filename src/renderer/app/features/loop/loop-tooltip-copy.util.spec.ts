import { describe, expect, it } from 'vitest';
import { chipTooltipFor, metricStripTooltipFor, resumeTooltipFor } from './loop-tooltip-copy.util';
import { TOOLTIP_COPY } from '../../shared/tooltip/tooltip-copy';
import { buildHonestyChips } from './loop-audit-chips.util';

describe('resumeTooltipFor (UX3)', () => {
  // The whole point: after a no-progress pause the situation is unchanged, and
  // the operator should know that before clicking.
  it('warns that nothing has changed when resuming a no-progress pause', () => {
    const text = resumeTooltipFor('no-progress');
    expect(text).toContain('not making progress');
    expect(text).toContain('may stall again');
  });

  it('uses the plain wording for any other pause', () => {
    for (const kind of ['awaiting-review', 'blocked', null, undefined]) {
      expect(resumeTooltipFor(kind), String(kind)).toBe(TOOLTIP_COPY['loop.resume'].meaning);
    }
  });
});

describe('metricStripTooltipFor (UX3)', () => {
  it('is empty with no active loop', () => {
    expect(metricStripTooltipFor(false, null)).toBe('');
  });

  it('explains each number in the strip', () => {
    const text = metricStripTooltipFor(true, null);
    expect(text).toContain('Iterations run so far');
    expect(text).toContain('Tokens this run has spent');
    expect(text).toContain('Estimated spend');
  });

  // T45 honesty: the cap is not the whole story.
  it('says an iteration cap adds a wrap-up turn', () => {
    expect(metricStripTooltipFor(true, null)).toContain('wrap-up turn');
  });

  // Cost is an estimate; saying so is the difference between a number and a bill.
  it('never presents the cost estimate as a bill', () => {
    expect(metricStripTooltipFor(true, null)).toContain('not a bill');
  });

  // Describing a line that is not on screen is its own small dishonesty.
  it('only explains the phase when one has been inferred', () => {
    expect(metricStripTooltipFor(true, null)).not.toContain('doing right now');
    expect(metricStripTooltipFor(true, 'verifying')).toContain('doing right now');
  });

  it('marks the phase as advisory', () => {
    expect(metricStripTooltipFor(true, 'editing')).toContain('Advisory');
  });
});

describe('chipTooltipFor (UX3)', () => {
  it('matches the chips buildHonestyChips actually emits', () => {
    expect(chipTooltipFor('unstick 1/2 · G')).toContain('nudged the agent');
    expect(chipTooltipFor('wrap-up · iterations cap')).toContain('hand-off notes');
    expect(chipTooltipFor('2 items parked')).toContain('set aside');
  });

  // L6: parked work must never read as dropped work.
  it('says parked work is kept', () => {
    expect(chipTooltipFor('1 item parked')).toContain('kept, not dropped');
  });

  // Every chip `buildHonestyChips` can emit must have copy; a chip the operator
  // cannot interrogate is the "named reason" half of L6 delivered in name only.
  it('explains every L6 named reason', () => {
    expect(chipTooltipFor('review not converging')).toContain('same unresolved finding');
    expect(chipTooltipFor('landable · uncommitted')).toContain('not committed');
    expect(chipTooltipFor('scope widened')).toContain('more files each iteration');
    expect(chipTooltipFor('no progress')).toContain('no more specific cause');
  });

  it('returns nothing for a chip it has no copy for, rather than inventing some', () => {
    expect(chipTooltipFor('something unrecognised')).toBe('');
    expect(chipTooltipFor('')).toBe('');
  });

  // Couples the two sides so a REWORDED chip fails here instead of silently
  // losing its tooltip — the way the L6 named-reason chip did.
  it('has copy for every chip buildHonestyChips can actually emit', () => {
    const emitted = buildHonestyChips({
      autoUnstick: { attempt: 1, max: 2, signalId: 'G' },
      capWrapUpIntent: { cap: 'iterations' },
      parkedLeaves: [{ id: 'a' }],
    });
    for (const reason of ['code_review_non_converging', 'landable_uncommitted', 'scope_expanded', 'no_progress']) {
      emitted.push(...buildHonestyChips({ nonConvergence: { reason } }));
    }

    expect(emitted.length).toBeGreaterThan(0);
    for (const chip of emitted) {
      expect(chipTooltipFor(chip), `no tooltip copy for chip "${chip}"`).not.toBe('');
    }
  });
});
