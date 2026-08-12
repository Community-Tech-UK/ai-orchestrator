import { describe, expect, it } from 'vitest';

import { resolveContextWarningLevel } from './context-warning-level';
import { RESTORED_CONTEXT_USAGE_SOURCE } from '../../../../shared/types/instance.types';
import type { ContextUsage } from '../../core/state/instance/instance.types';

/** A provider-reported window occupancy. */
function occupancy(percentage: number): ContextUsage {
  return {
    used: Math.round((percentage / 100) * 200_000),
    total: 200_000,
    percentage,
    occupancyReported: true,
  };
}

/** Cumulative turn spend from a provider with no window reading (LT-034). */
function aggregate(percentage: number): ContextUsage {
  return { ...occupancy(percentage), occupancyIsAggregate: true };
}

describe('resolveContextWarningLevel', () => {
  describe('real occupancy — thresholds unchanged', () => {
    it.each([
      [74, null],
      [75, 'warning'],
      [79, 'warning'],
      [80, 'critical'],
      [94, 'critical'],
      [95, 'emergency'],
      [100, 'emergency'],
    ])('reads %i%% as %s', (pct, expected) => {
      expect(resolveContextWarningLevel(occupancy(pct), false)).toBe(expected);
    });
  });

  describe('aggregate-only providers (LT-034)', () => {
    // `'emergency'` disables the composer. Spend is monotonically
    // non-decreasing and clamped at 100, so without this guard every long
    // Copilot/Gemini/Codex-exec session eventually locks its own input box
    // over a context that may be nearly empty.
    it.each([75, 80, 95, 100])('never warns at %i%% of cumulative spend', (pct) => {
      expect(resolveContextWarningLevel(aggregate(pct), false)).toBeNull();
    });

    it('specifically never reaches emergency, which disables the composer', () => {
      expect(resolveContextWarningLevel(aggregate(99), false)).not.toBe('emergency');
    });
  });

  describe('unreported occupancy (LT-018)', () => {
    it('does not warn off the create-time placeholder', () => {
      expect(resolveContextWarningLevel(
        { used: 0, total: 200_000, percentage: 0 },
        false,
      )).toBeNull();
    });

    it('does not warn on a high percentage that was never reported', () => {
      expect(resolveContextWarningLevel(
        { used: 190_000, total: 200_000, percentage: 95 },
        false,
      )).toBeNull();
    });

    it('returns null for a missing reading rather than throwing', () => {
      expect(resolveContextWarningLevel(undefined, false)).toBeNull();
    });
  });

  describe('restored readings do not lock the composer (LT-034)', () => {
    // `'emergency'` disables the composer, and sending is the only thing that
    // produces a fresh context event — so a stale reading that locks input
    // blocks its own correction. Worst case: a session hibernated before
    // `occupancyIsAggregate` existed wakes with a pinned spend percentage and
    // no flag.
    const restored = (percentage: number): ContextUsage => ({
      ...occupancy(percentage),
      source: RESTORED_CONTEXT_USAGE_SOURCE,
    });

    it('caps a restored 95%+ reading at critical instead of emergency', () => {
      expect(resolveContextWarningLevel(restored(99), false)).toBe('critical');
    });

    it('still shows a banner, so the user is not left uninformed', () => {
      expect(resolveContextWarningLevel(restored(99), false)).not.toBeNull();
    });

    it('leaves lower restored thresholds unchanged', () => {
      expect(resolveContextWarningLevel(restored(80), false)).toBe('critical');
      expect(resolveContextWarningLevel(restored(75), false)).toBe('warning');
      expect(resolveContextWarningLevel(restored(50), false)).toBeNull();
    });

    it('a LIVE reading at the same percentage still reaches emergency', () => {
      expect(resolveContextWarningLevel(occupancy(99), false)).toBe('emergency');
    });
  });

  describe('self-managing adapters', () => {
    it('defers to the provider even at emergency occupancy', () => {
      expect(resolveContextWarningLevel(occupancy(99), true)).toBeNull();
    });
  });
});
