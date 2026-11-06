import { describe, expect, it } from 'vitest';
import { computeTokenCost, getModelRate } from './model-pricing';

describe('cache lifetime and request-size pricing', () => {
  it('prices Claude writes by lifetime without adding the aggregate twice', () => {
    const inputRate = getModelRate('claude-sonnet-5-5').input;
    expect(computeTokenCost('claude-sonnet-5-5', {
      cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 600_000, cacheWrite1hTokens: 400_000,
    })).toBeCloseTo(inputRate * (0.6 * 1.25 + 0.4 * 2));
    expect(computeTokenCost('sonnet', { cacheWriteTokens: 1_000_000 })).toBeCloseTo(inputRate * 1.6);
    expect(computeTokenCost('sonnet', { cacheWrite5mTokens: 1_000_000 })).toBeCloseTo(inputRate * 1.25);
  });

  it('uses the fallback only for the unclassified remainder', () => {
    expect(computeTokenCost('sonnet', { cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 500_000 }))
      .toBeCloseTo(2 * (0.5 * 1.25 + 0.5 * 1.6));
  });

  it.each(['gpt-6.1-sol', 'gpt-6-astra'])('applies the full-request long-prompt rates to %s only above 272K', (model) => {
    const rate = getModelRate(model);
    const usage = { inputTokens: 100_000, cacheReadTokens: 200_000, outputTokens: 1000, reasoningTokens: 1000 };
    const cache = model === 'gpt-6.1-sol' ? 0.05 : 0.1;
    const base = (100_000 * rate.input + 200_000 * rate.input * cache + 2000 * rate.output) / 1e6;
    expect(computeTokenCost(model, { ...usage, requestInputTokens: 272_000 })).toBeCloseTo(base);
    expect(computeTokenCost(model, { ...usage, requestInputTokens: 272_001 }))
      .toBeCloseTo((2 * (100_000 * rate.input + 200_000 * rate.input * cache) + 1.5 * 2000 * rate.output) / 1e6);
    // Turn/session aggregates are not evidence that any one request was large.
    expect(computeTokenCost(model, usage)).toBeCloseTo(base);
  });
});
