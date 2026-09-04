/**
 * LF-1 (loopfixex.md) — context-discipline decision logic.
 * WS4 (loop-convergence plan) — recycling acts only on a `known` occupancy
 * observation; aggregate tokens are diagnostics only and can never recycle.
 */

import { describe, expect, it } from 'vitest';
import { LOOP_CONTEXT_WINDOW_TOKENS } from '../../shared/types/loop.types';
import {
  loopContextUtilization,
  shouldRecycleLoopContext,
  type ContextUsageObservation,
} from './loop-context-discipline';

const known = (used: number, total: number): ContextUsageObservation =>
  ({ status: 'known', used, total, source: 'provider-turn' });
const unknown = (reason: 'not-reported' | 'aggregate-only' | 'invalid-sample'): ContextUsageObservation =>
  ({ status: 'unknown', reason });

describe('loopContextUtilization (diagnostic-only helper)', () => {
  it('computes cumulative / window, clamped at 0 floor', () => {
    expect(loopContextUtilization(0)).toBe(0);
    expect(loopContextUtilization(-100)).toBe(0);
    expect(loopContextUtilization(LOOP_CONTEXT_WINDOW_TOKENS)).toBe(1);
    expect(loopContextUtilization(LOOP_CONTEXT_WINDOW_TOKENS / 2)).toBeCloseTo(0.5, 5);
    expect(loopContextUtilization(50, 0)).toBe(0); // guard zero window
  });
});

describe('shouldRecycleLoopContext — known occupancy', () => {
  it('REGRESSION (incident): 7M aggregate tokens + a current 60k/200k observation is 30% and must NOT recycle at 60%', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: known(60_000, 200_000),
      cumulativeTokens: 7_000_000,
    });
    expect(d.recycle).toBe(false);
    expect(d.utilization).toBeCloseTo(0.3, 5);
    expect(d.occupancyUnavailable).toBe(false);
    expect(d.reason).toContain('context occupancy');
  });

  it('recycles at/above the threshold', () => {
    const at = shouldRecycleLoopContext({
      enabled: true, resetAtUtilization: 0.6, observation: known(120_000, 200_000),
    });
    expect(at.recycle).toBe(true);
    expect(at.reason).toContain('recycling');

    const above = shouldRecycleLoopContext({
      enabled: true, resetAtUtilization: 0.6, observation: known(190_000, 200_000),
    });
    expect(above.recycle).toBe(true);
  });

  it('stays below the threshold without recycling', () => {
    const d = shouldRecycleLoopContext({
      enabled: true, resetAtUtilization: 0.6, observation: known(590, 1000),
    });
    expect(d.recycle).toBe(false);
    expect(d.utilization).toBeCloseTo(0.59, 5);
  });

  it('never recycles when disabled', () => {
    const d = shouldRecycleLoopContext({
      enabled: false, resetAtUtilization: 0.6, observation: known(950, 1000),
    });
    expect(d.recycle).toBe(false);
    expect(d.reason).toContain('disabled');
  });

  it('uses the calibrated window as denominator ONLY for a known sample missing a usable total', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: known(140_000, 0),
      calibratedWindowTokens: 200_000,
    });
    expect(d.recycle).toBe(true);
    expect(d.utilization).toBeCloseTo(0.7, 5);
  });

  it('treats a known sample with unusable values (and no calibration) as unavailable', () => {
    const noTotal = shouldRecycleLoopContext({
      enabled: true, resetAtUtilization: 0.6, observation: known(140_000, 0),
    });
    expect(noTotal.recycle).toBe(false);
    expect(noTotal.occupancyUnavailable).toBe(true);

    const noUsed = shouldRecycleLoopContext({
      enabled: true, resetAtUtilization: 0.6, observation: known(0, 200_000),
    });
    expect(noUsed.recycle).toBe(false);
    expect(noUsed.occupancyUnavailable).toBe(true);
  });

  it('T1a: currentTokens/tokenLimit at the reset threshold recycles', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: {
        status: 'known',
        used: 70_000,
        total: 100_000,
        source: 'provider-session',
        windowTrusted: true,
      },
    });
    expect(d.recycle).toBe(true);
    expect(d.utilization).toBeCloseTo(0.7, 5);
  });

  it('T1a: high-tools / low-conversation still recycles unless static overhead alone meets the threshold', () => {
    const stillRecycles = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: {
        status: 'known',
        used: 70_000,
        total: 100_000,
        source: 'provider-session',
        windowTrusted: true,
        conversationTokens: 5_000,
        systemTokens: 10_000,
        toolDefinitionsTokens: 40_000,
      },
    });
    expect(stillRecycles.recycle).toBe(true);
    expect(stillRecycles.reason).not.toContain('static-overhead');

    const blocked = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: {
        status: 'known',
        used: 85_000,
        total: 100_000,
        source: 'provider-session',
        windowTrusted: true,
        conversationTokens: 5_000,
        systemTokens: 10_000,
        toolDefinitionsTokens: 70_000,
      },
    });
    expect(blocked.recycle).toBe(false);
    expect(blocked.occupancyUnavailable).toBe(false);
    expect(blocked.reason).toContain('static-overhead');
  });

  it('T1a: an untrusted window never becomes a recycle percentage', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: {
        status: 'known',
        used: 180_000,
        total: 200_000,
        source: 'provider-session',
        windowTrusted: false,
      },
    });
    expect(d.recycle).toBe(false);
    expect(d.occupancyUnavailable).toBe(true);
    expect(d.reason).toContain('not provider-trusted');
  });
});

describe('shouldRecycleLoopContext — unknown occupancy (aggregate can never recycle)', () => {
  it('REGRESSION (incident): 7M aggregate tokens + unknown aggregate-only must NOT recycle and must explain why', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: unknown('aggregate-only'),
      cumulativeTokens: 7_000_000,
    });
    expect(d.recycle).toBe(false);
    expect(d.utilization).toBe(0);
    expect(d.occupancyUnavailable).toBe(true);
    expect(d.reason).toContain('occupancy unavailable');
    expect(d.reason).toContain('aggregate');
    // The aggregate figure appears as a diagnostic annotation, never a metric.
    expect(d.reason).toContain('7,000,000');
    expect(d.reason).toContain('not occupancy');
  });

  it('not-reported and invalid-sample also never recycle', () => {
    for (const reason of ['not-reported', 'invalid-sample'] as const) {
      const d = shouldRecycleLoopContext({
        enabled: true, resetAtUtilization: 0.6, observation: unknown(reason),
      });
      expect(d.recycle).toBe(false);
      expect(d.occupancyUnavailable).toBe(true);
      expect(d.reason).toContain('occupancy unavailable');
    }
  });
});

describe('shouldRecycleLoopContext — T1 ceiling', () => {
  it('recycles resume-capable unknown occupancy after the iteration ceiling', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: unknown('aggregate-only'),
      cumulativeTokens: 10_000,
      ceiling: { supportsResume: true, iterationsSinceRecycle: 8 },
    });
    expect(d.recycle).toBe(true);
    expect(d.reason).toContain('occupancyUnavailable + ceiling');
    expect(d.reason).toContain('8 iterations');
  });

  it('recycles resume-capable unknown occupancy after the aggregate-token ceiling', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: unknown('aggregate-only'),
      cumulativeTokens: 100_000,
      ceiling: { supportsResume: true, iterationsSinceRecycle: 2 },
    });
    expect(d.recycle).toBe(true);
    expect(d.reason).toContain('100,000 aggregate tokens');
  });

  it('never ceilings Gemini/Antigravity (supportsResume false)', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: unknown('aggregate-only'),
      cumulativeTokens: 7_000_000,
      ceiling: { supportsResume: false, iterationsSinceRecycle: 50 },
    });
    expect(d.recycle).toBe(false);
    expect(d.occupancyUnavailable).toBe(true);
  });

  it('WS4: unknown without a ceiling argument still does not recycle', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: unknown('aggregate-only'),
      cumulativeTokens: 7_000_000,
    });
    expect(d.recycle).toBe(false);
  });

  it('falls through to the ceiling after a static-overhead occupancy skip', () => {
    const d = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: {
        status: 'known',
        used: 85_000,
        total: 100_000,
        source: 'provider-session',
        windowTrusted: true,
        conversationTokens: 5_000,
        systemTokens: 10_000,
        toolDefinitionsTokens: 70_000,
      },
      cumulativeTokens: 100_000,
      ceiling: { supportsResume: true, iterationsSinceRecycle: 2 },
    });
    expect(d.recycle).toBe(true);
    expect(d.reason).toContain('static-overhead');
    expect(d.reason).toContain('occupancyUnavailable + ceiling');
  });
});
