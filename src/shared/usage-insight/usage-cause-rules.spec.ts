import { describe, expect, it } from 'vitest';
import {
  ALWAYS_ON_TOKENS,
  BIG_TOOL_RESULT_TOKENS,
  CACHE_MISS_TOKENS,
  HELPER_HEAVY_SHARE,
  IDLE_GAP_CAP_MS,
  LONG_CONTEXT_TOKENS,
  LONG_RUNNING_HOURS,
  PARALLEL_BUCKET_MS,
  PARALLEL_SESSIONS,
  SHOW_THRESHOLD_PERCENT,
  SHOW_THRESHOLD_SHARE,
  USAGE_CAUSES,
  USAGE_WINDOW_MS,
  isCauseShown,
  shownCauses,
  sharePercent,
  unmeasuredCauses,
  usageCauseDefinition,
} from './usage-cause-rules';
import { USAGE_CAUSE_IDS, type UsageCauseId, type UsageCauseResult } from './usage-insight.types';

function result(id: UsageCauseId, percent: number | null, extra: Partial<UsageCauseResult> = {}): UsageCauseResult {
  return {
    id,
    share: percent === null ? null : percent / 100,
    percent,
    shown: isCauseShown(percent === null ? null : percent / 100),
    requests: 0,
    sessions: 0,
    ...extra,
  };
}

describe('the numbers Anthropic names for its nine causes', () => {
  it('uses the thresholds from the cause names', () => {
    expect(SHOW_THRESHOLD_PERCENT).toBe(10);
    expect(SHOW_THRESHOLD_SHARE).toBe(0.1);
    expect(USAGE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(CACHE_MISS_TOKENS).toBe(100_000);
    expect(LONG_CONTEXT_TOKENS).toBe(150_000);
    expect(PARALLEL_SESSIONS).toBe(4);
    expect(LONG_RUNNING_HOURS).toBe(8);
    expect(ALWAYS_ON_TOKENS).toBe(40_000);
    expect(BIG_TOOL_RESULT_TOKENS).toBe(10_000);
    expect(HELPER_HEAVY_SHARE).toBe(0.5);
  });

  it('keeps the two time limits the estimate wording quotes: five minutes together, 30 minutes of work per gap', () => {
    expect(PARALLEL_BUCKET_MS).toBe(5 * 60 * 1000);
    expect(IDLE_GAP_CAP_MS).toBe(30 * 60 * 1000);
  });
});

describe('causes that rest on an approximation', () => {
  it('marks the three the records cannot confirm exactly: working together, open all day, big results', () => {
    const estimated = USAGE_CAUSES.filter((entry) => entry.estimated).map((entry) => entry.id);
    expect(estimated).toEqual(['parallelSessions', 'longRunning', 'bigToolResults']);
  });

  it.each(['cacheMiss', 'longContext', 'helperHeavy', 'maxEffort', 'workflows', 'alwaysOnContext'] as const)(
    'does not mark %s, which comes straight from recorded counts or settings',
    (id) => {
      expect(usageCauseDefinition(id).estimated).toBeUndefined();
    },
  );
});

describe('cause buttons', () => {
  it('has one definition per cause, in the plan order', () => {
    expect(USAGE_CAUSES.map((entry) => entry.id)).toEqual([...USAGE_CAUSE_IDS]);
  });

  it('gives buttons only to the causes the plan names', () => {
    const withButtons = USAGE_CAUSES.filter((entry) => entry.action).map((entry) => entry.id);
    expect(withButtons).toEqual(['cacheMiss', 'longContext', 'helperHeavy', 'longRunning', 'alwaysOnContext']);
  });

  it('points each button at the control the plan names', () => {
    expect(usageCauseDefinition('cacheMiss').action).toEqual({ kind: 'compact-session', label: 'Compact first' });
    expect(usageCauseDefinition('longContext').action).toMatchObject({ kind: 'open-settings', tab: 'memory' });
    expect(usageCauseDefinition('helperHeavy').action).toMatchObject({ kind: 'open-settings', tab: 'orchestration' });
    expect(usageCauseDefinition('longRunning').action).toMatchObject({ kind: 'open-route', path: '/automations' });
    expect(usageCauseDefinition('alwaysOnContext').action).toMatchObject({ kind: 'open-context-details' });
  });

  it.each(['parallelSessions', 'maxEffort', 'workflows'] as const)('gives %s a sentence only', (id) => {
    expect(usageCauseDefinition(id).action).toBeUndefined();
  });

  it('gives big tool results no button until a setting for the result limits exists', () => {
    expect(usageCauseDefinition('bigToolResults').action).toBeUndefined();
  });

  it('gives every button a short label that does not use internal words', () => {
    for (const { action } of USAGE_CAUSES) {
      if (!action) continue;
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.label).not.toMatch(/AIO|node|worker|IPC/i);
    }
  });
});

describe('sharePercent', () => {
  it.each([
    [0, 0],
    [0.094, 9],
    [0.095, 10],
    [0.1, 10],
    [0.996, 100],
    [1, 100],
    [-0.5, 0],
    [3, 100],
  ])('turns %s into %s percent', (share, expected) => {
    expect(sharePercent(share)).toBe(expected);
  });
});

describe('isCauseShown', () => {
  it('shows a cause when its actual share is 10% or more', () => {
    expect(isCauseShown(0.1)).toBe(true);
    expect(isCauseShown(0.1000001)).toBe(true);
    expect(isCauseShown(0.55)).toBe(true);
    expect(isCauseShown(1)).toBe(true);
  });

  it('hides a cause under 10%, even when its label would round up to 10', () => {
    for (const share of [0.0999, 0.0995, 0.095, 0.09, 0]) expect(isCauseShown(share)).toBe(false);
    // The label rounds to a whole percent; the decision to show it does not.
    expect(sharePercent(0.095)).toBe(10);
    expect(sharePercent(0.0995)).toBe(10);
  });

  it('never admits a stored share below the exact boundary, even by a tiny amount', () => {
    expect(isCauseShown(0.3 / 3)).toBe(false);
    expect(isCauseShown(0.1 - Number.EPSILON)).toBe(false);
    expect(isCauseShown(0.1 - 1e-12)).toBe(false);
    expect(isCauseShown(0.099999)).toBe(false);
  });

  it('never shows a cause that was not measured or has no usable number', () => {
    expect(isCauseShown(null)).toBe(false);
    expect(isCauseShown(Number.NaN)).toBe(false);
    expect(isCauseShown(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('shownCauses', () => {
  it('keeps only causes at 10 percent or more, in the plan order', () => {
    const shown = shownCauses([
      result('bigToolResults', 40),
      result('cacheMiss', 12),
      result('longContext', 9),
      result('parallelSessions', 55),
      result('maxEffort', null, { unavailable: 'effort-not-recorded' }),
    ]);
    expect(shown.map((entry) => entry.id)).toEqual(['cacheMiss', 'parallelSessions', 'bigToolResults']);
  });
});

describe('unmeasuredCauses', () => {
  it('lists the causes that could not be measured, so they are not silently dropped', () => {
    const unmeasured = unmeasuredCauses([
      result('cacheMiss', 5),
      result('maxEffort', null, { unavailable: 'effort-not-recorded' }),
      result('workflows', null, { unavailable: 'effort-not-recorded' }),
    ]);
    expect(unmeasured.map((entry) => entry.id)).toEqual(['maxEffort', 'workflows']);
  });
});
