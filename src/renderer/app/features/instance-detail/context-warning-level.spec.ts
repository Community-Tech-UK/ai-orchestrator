import { describe, expect, it } from 'vitest';

import { buildClaudeContextNoteSentence, resolveClaudeContextNote, resolveContextWarningLevel } from './context-warning-level';
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

describe('resolveClaudeContextNote', () => {
  const ceilings = { machineContextCeilingTokens: 400_000, ownChatContextCeilingTokens: 400_000 };
  const instance = {
    provider: 'claude', selfManagesAutoCompaction: true,
    contextUsage: { used: 303_000, total: 1_000_000, percentage: 30, occupancyReported: true },
  };

  it('shows the gap to Claude’s actual summary trigger', () => {
    expect(resolveClaudeContextNote(instance, ceilings))
      .toBe('Claude will summarise this conversation in about 64K tokens.');
    expect(buildClaudeContextNoteSentence(-10)).toContain('about 0 tokens');
  });

  it('stays quiet until 100K before the trigger and ignores aggregate readings', () => {
    expect(resolveClaudeContextNote({ ...instance, contextUsage: {
      ...instance.contextUsage, used: 266_999,
    } }, ceilings)).toBeNull();
    expect(resolveClaudeContextNote({ ...instance, contextUsage: {
      ...instance.contextUsage, used: 267_000,
    } }, ceilings)).toContain('about 100K');
    expect(resolveClaudeContextNote({ ...instance, contextUsage: {
      ...instance.contextUsage, occupancyIsAggregate: true,
    } }, ceilings)).toBeNull();
  });

  it('uses the shared machine-session classifier for the lower machine ceiling', () => {
    const split = { machineContextCeilingTokens: 400_000, ownChatContextCeilingTokens: 500_000 };
    const nearMachine = { ...instance, contextUsage: { ...instance.contextUsage, used: 320_000 } };
    expect(resolveClaudeContextNote(nearMachine, split)).toBeNull();
    expect(resolveClaudeContextNote({ ...nearMachine, metadata: { spendPurpose: 'plan-queue' } }, split))
      .toContain('about 47K');
    expect(resolveClaudeContextNote({ ...nearMachine, parentId: 'parent' }, split))
      .toContain('about 47K');
  });

  it('requires a self-compacting Claude session and a positive ceiling', () => {
    expect(resolveClaudeContextNote({ ...instance, provider: 'codex' }, ceilings)).toBeNull();
    expect(resolveClaudeContextNote({ ...instance, selfManagesAutoCompaction: false }, ceilings)).toBeNull();
    expect(resolveClaudeContextNote(instance, { ...ceilings, ownChatContextCeilingTokens: 0 })).toBeNull();
  });
});
