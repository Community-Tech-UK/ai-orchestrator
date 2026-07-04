import { describe, it, expect } from 'vitest';
import {
  computeInitWaitBudgetMs,
  INIT_WAIT_BASE_MS,
  INIT_WAIT_CONTEXT_FREE_TOKENS,
  INIT_WAIT_MS_PER_1K_TOKENS,
  INIT_WAIT_MAX_MS,
} from './init-wait-budget';

describe('computeInitWaitBudgetMs', () => {
  it('returns the base budget for a small, calm session', () => {
    expect(computeInitWaitBudgetMs(0, 1)).toBe(INIT_WAIT_BASE_MS);
    expect(computeInitWaitBudgetMs(INIT_WAIT_CONTEXT_FREE_TOKENS, 1)).toBe(INIT_WAIT_BASE_MS);
    // Below the free floor adds nothing.
    expect(computeInitWaitBudgetMs(10_000, 1)).toBe(INIT_WAIT_BASE_MS);
  });

  it('grants extra time proportional to replayable tokens above the free floor', () => {
    // 150k tokens → 100k replayable → 100 * 500ms = 50s on top of the 30s base.
    const tokens = INIT_WAIT_CONTEXT_FREE_TOKENS + 100_000;
    const expected = INIT_WAIT_BASE_MS + 100 * INIT_WAIT_MS_PER_1K_TOKENS;
    expect(computeInitWaitBudgetMs(tokens, 1)).toBe(expected);
  });

  it('scales the whole budget by host load', () => {
    const tokens = INIT_WAIT_CONTEXT_FREE_TOKENS + 20_000; // 30_000 + 20*500 = 40_000 base
    const single = computeInitWaitBudgetMs(tokens, 1);
    expect(single).toBe(40_000);
    expect(computeInitWaitBudgetMs(tokens, 2)).toBe(Math.min(80_000, INIT_WAIT_MAX_MS));
  });

  it('reproduces the incident: a 217k-token session waits far longer than the old fixed 30s', () => {
    const budget = computeInitWaitBudgetMs(217_723, 1);
    expect(budget).toBeGreaterThan(30_000);
    // (217723 - 50000)/1000 * 500 = 83_861.5 + 30_000 = 113_861.5, under the cap.
    expect(budget).toBeCloseTo(113_861.5, 1);
  });

  it('clamps to the hard ceiling for huge contexts / heavy load', () => {
    expect(computeInitWaitBudgetMs(5_000_000, 1)).toBe(INIT_WAIT_MAX_MS);
    expect(computeInitWaitBudgetMs(217_723, 8)).toBe(INIT_WAIT_MAX_MS);
  });

  it('never returns less than the base budget', () => {
    expect(computeInitWaitBudgetMs(0, 1)).toBeGreaterThanOrEqual(INIT_WAIT_BASE_MS);
  });

  it('defends against non-finite / degenerate inputs', () => {
    expect(computeInitWaitBudgetMs(NaN, NaN)).toBe(INIT_WAIT_BASE_MS);
    expect(computeInitWaitBudgetMs(-100, 0)).toBe(INIT_WAIT_BASE_MS);
    // Non-finite token counts are degenerate — treated as 0, not the ceiling.
    expect(computeInitWaitBudgetMs(Infinity, 1)).toBe(INIT_WAIT_BASE_MS);
    // A sub-1 multiplier is treated as calm (1), not a budget shrink.
    expect(computeInitWaitBudgetMs(0, 0.5)).toBe(INIT_WAIT_BASE_MS);
  });
});
