/**
 * Regression cover for the ~2.75x loop-spend overstatement.
 *
 * The legacy estimator priced `tokens` — a total that INCLUDES cache reads — at
 * a flat $15/Mtok. Cache reads bill at ~10% of the input rate, so a cache-heavy
 * iteration (the common case once a session is warm) was massively overpriced.
 * These tests pin the precedence and prove the cache-read discount is applied.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearModelRateOverlay, registerModelRates } from '../../shared/data/model-pricing';
import { COST_PER_M_TOKENS_CENTS } from './loop-coordinator.types';
import { resolveIterationCost } from './loop-iteration-cost';

// Sonnet-class rates: $3/Mtok in, $15/Mtok out. Registered explicitly so the
// test does not depend on the committed pricing snapshot.
const MODEL = 'test-sonnet';

beforeEach(() => {
  clearModelRateOverlay();
  registerModelRates({ [MODEL]: { input: 3, output: 15 } });
});

describe('resolveIterationCost', () => {
  it('prefers the provider-reported dollar cost above everything else', () => {
    const cost = resolveIterationCost({
      tokens: 1_000_000,
      costUsd: 0.42,
      model: MODEL,
      usage: { inputTokens: 999_999, outputTokens: 999_999 },
    });

    expect(cost).toEqual({ costCents: 42, basis: 'provider-reported', costKnown: true });
  });

  it('does not overstate a cache-heavy iteration (the 2.75x bug)', () => {
    // 1M cache reads + 10k real input + 5k output. This is what a warm,
    // resumed session actually looks like.
    const usage = { inputTokens: 10_000, outputTokens: 5_000, cacheReadTokens: 1_000_000 };
    const tokens = 1_015_000; // what the adapter reports as the scalar total

    const cost = resolveIterationCost({ tokens, usage, model: MODEL });

    // Correct: (10k * $3 + 5k * $15 + 1M * $3 * 0.1) / 1e6
    //        = ($0.03 + $0.075 + $0.30) = $0.405 -> 41 cents (ceil)
    expect(cost.basis).toBe('computed');
    expect(cost.costKnown).toBe(false);
    expect(cost.costCents).toBe(41);

    // The legacy estimator would have charged $15/Mtok on the whole 1.015M:
    const legacyCents = Math.ceil((tokens / 1_000_000) * COST_PER_M_TOKENS_CENTS);
    expect(legacyCents).toBe(1523); // $15.23

    // ...i.e. it was ~37x too expensive on this shape. Guard the direction so a
    // regression that reinstates the flat estimate fails loudly.
    expect(cost.costCents).toBeLessThan(legacyCents);
  });

  it('prices cache writes at the full input rate, unlike cache reads', () => {
    const read = resolveIterationCost({
      tokens: 1_000_000,
      usage: { cacheReadTokens: 1_000_000 },
      model: MODEL,
    });
    const write = resolveIterationCost({
      tokens: 1_000_000,
      usage: { cacheWriteTokens: 1_000_000 },
      model: MODEL,
    });

    expect(read.costCents).toBe(30); // 1M * $3 * 0.1 = $0.30
    expect(write.costCents).toBe(300); // 1M * $3     = $3.00
    // A cache write costs 10x a cache read. This is exactly why a cold
    // (unresumed) session per iteration is expensive.
    expect(write.costCents).toBe(read.costCents * 10);
  });

  it('falls back to the legacy flat estimate only when no usage was reported', () => {
    const cost = resolveIterationCost({ tokens: 2_000_000, model: MODEL });

    expect(cost.basis).toBe('legacy-estimate');
    expect(cost.costKnown).toBe(false);
    expect(cost.costCents).toBe(3000); // 2M * $15/M = $30.00
  });

  it('treats an all-zero usage record as no breakdown', () => {
    const cost = resolveIterationCost({
      tokens: 1_000,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      model: MODEL,
    });

    expect(cost.basis).toBe('legacy-estimate');
  });

  it('never returns a negative cost when a provider reports a nonsense value', () => {
    expect(resolveIterationCost({ tokens: 0, costUsd: -5 }).costCents).toBe(0);
  });

  it('ignores a non-finite provider cost and computes instead', () => {
    const cost = resolveIterationCost({
      tokens: 1000,
      costUsd: Number.NaN,
      usage: { outputTokens: 1_000_000 },
      model: MODEL,
    });

    expect(cost.basis).toBe('computed');
    expect(cost.costCents).toBe(1500); // 1M * $15/M
  });
});
