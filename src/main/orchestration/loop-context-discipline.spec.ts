/**
 * LF-1 (loopfixex.md) — context-discipline decision logic.
 */

import { describe, expect, it } from 'vitest';
import { LOOP_CONTEXT_WINDOW_TOKENS } from '../../shared/types/loop.types';
import { loopContextUtilization, shouldRecycleLoopContext } from './loop-context-discipline';

describe('loopContextUtilization', () => {
  it('computes cumulative / window, clamped at 0 floor', () => {
    expect(loopContextUtilization(0)).toBe(0);
    expect(loopContextUtilization(-100)).toBe(0);
    expect(loopContextUtilization(LOOP_CONTEXT_WINDOW_TOKENS)).toBe(1);
    expect(loopContextUtilization(LOOP_CONTEXT_WINDOW_TOKENS / 2)).toBeCloseTo(0.5, 5);
    expect(loopContextUtilization(50, 0)).toBe(0); // guard zero window
  });
});

describe('shouldRecycleLoopContext', () => {
  it('recycles once cumulative tokens cross the reset threshold', () => {
    const window = 1000;
    const below = shouldRecycleLoopContext({ enabled: true, cumulativeTokens: 590, resetAtUtilization: 0.6, windowTokens: window });
    expect(below.recycle).toBe(false);
    expect(below.utilization).toBeCloseTo(0.59, 5);

    const at = shouldRecycleLoopContext({ enabled: true, cumulativeTokens: 600, resetAtUtilization: 0.6, windowTokens: window });
    expect(at.recycle).toBe(true);
    expect(at.reason).toContain('recycling');

    const above = shouldRecycleLoopContext({ enabled: true, cumulativeTokens: 950, resetAtUtilization: 0.6, windowTokens: window });
    expect(above.recycle).toBe(true);
  });

  it('never recycles when disabled (returns utilization for observability)', () => {
    const d = shouldRecycleLoopContext({ enabled: false, cumulativeTokens: 999_999, resetAtUtilization: 0.6, windowTokens: 1000 });
    expect(d.recycle).toBe(false);
    expect(d.utilization).toBeGreaterThan(0.6);
    expect(d.reason).toContain('disabled');
  });

  it('uses the default loop window when none is supplied', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      cumulativeTokens: LOOP_CONTEXT_WINDOW_TOKENS * 0.7,
      resetAtUtilization: 0.6,
    });
    expect(d.recycle).toBe(true);
    expect(d.utilization).toBeCloseTo(0.7, 5);
  });

  it('prefers real context occupancy over the cumulative heuristic when provided', () => {
    // Cumulative tokens would scream "recycle" (3621% of the synthetic window,
    // the 7.24M-token pathological iteration), but the actual context is only
    // 30% full — occupancy wins and the session is NOT recycled.
    const d = shouldRecycleLoopContext({
      enabled: true,
      cumulativeTokens: 7_242_440,
      resetAtUtilization: 0.6,
      occupancyTokens: 60_000,
      occupancyWindowTokens: 200_000,
    });
    expect(d.recycle).toBe(false);
    expect(d.utilization).toBeCloseTo(0.3, 5);
    expect(d.reason).toContain('context occupancy');
  });

  it('recycles on real occupancy crossing the threshold even when cumulative is low', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      cumulativeTokens: 10_000,
      resetAtUtilization: 0.6,
      occupancyTokens: 130_000,
      occupancyWindowTokens: 200_000,
    });
    expect(d.recycle).toBe(true);
    expect(d.utilization).toBeCloseTo(0.65, 5);
    expect(d.reason).toContain('recycling');
  });

  it('falls back to the cumulative heuristic when occupancy is absent or zero', () => {
    const absent = shouldRecycleLoopContext({
      enabled: true,
      cumulativeTokens: 700,
      resetAtUtilization: 0.6,
      windowTokens: 1000,
    });
    expect(absent.recycle).toBe(true);
    expect(absent.reason).toContain('cumulative tokens');

    const zero = shouldRecycleLoopContext({
      enabled: true,
      cumulativeTokens: 700,
      resetAtUtilization: 0.6,
      windowTokens: 1000,
      occupancyTokens: 0,
    });
    expect(zero.recycle).toBe(true);
    expect(zero.reason).toContain('cumulative tokens');
  });
});
