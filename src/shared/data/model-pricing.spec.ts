import { describe, it, expect, afterEach } from 'vitest';
import {
  computeTokenCost,
  getModelRate,
  hasModelRate,
  registerModelRates,
  clearModelRateOverlay,
  modelRateOverlaySize,
  DEFAULT_MODEL_RATE,
} from './model-pricing';
import { CLAUDE_MODELS, MODEL_PRICING } from '../types/provider.types';

describe('computeTokenCost', () => {
  it('prices input and output with the per-model rate', () => {
    const rate = MODEL_PRICING[CLAUDE_MODELS.OPUS];
    const cost = computeTokenCost(CLAUDE_MODELS.OPUS, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(rate.input + rate.output, 6);
  });

  it('prices cache reads at 10% of input and cache writes at the input rate', () => {
    const rate = MODEL_PRICING[CLAUDE_MODELS.OPUS];
    const cost = computeTokenCost(CLAUDE_MODELS.OPUS, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(rate.input * 0.1 + rate.input, 6);
  });

  it('falls back to the default rate for unknown models', () => {
    const cost = computeTokenCost('totally-unknown-model', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(DEFAULT_MODEL_RATE.input, 6);
  });

  it('clamps negative and missing counts to zero', () => {
    expect(computeTokenCost(CLAUDE_MODELS.OPUS, {})).toBe(0);
    expect(
      computeTokenCost(CLAUDE_MODELS.OPUS, { inputTokens: -100, outputTokens: -50 }),
    ).toBe(0);
  });

  it('treats null/undefined model as the default rate', () => {
    expect(getModelRate(undefined)).toEqual(DEFAULT_MODEL_RATE);
    expect(getModelRate(null)).toEqual(DEFAULT_MODEL_RATE);
    expect(hasModelRate(undefined)).toBe(false);
    expect(hasModelRate(CLAUDE_MODELS.OPUS)).toBe(true);
  });
});

describe('model-pricing live overlay (models.dev)', () => {
  afterEach(() => {
    clearModelRateOverlay();
  });

  it('prefers an overlay rate over the static snapshot', () => {
    const staticRate = MODEL_PRICING[CLAUDE_MODELS.OPUS];
    registerModelRates({ [CLAUDE_MODELS.OPUS]: { input: 999, output: 1234 } });

    expect(getModelRate(CLAUDE_MODELS.OPUS)).toEqual({ input: 999, output: 1234 });
    // computeTokenCost reflects the overlay, not the snapshot.
    const cost = computeTokenCost(CLAUDE_MODELS.OPUS, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(999, 6);
    expect(cost).not.toBeCloseTo(staticRate.input, 6);
  });

  it('prices a model that exists only in the overlay (new model, not in snapshot)', () => {
    expect(hasModelRate('brand-new-model-x')).toBe(false);
    registerModelRates({ 'brand-new-model-x': { input: 2, output: 8 } });

    expect(hasModelRate('brand-new-model-x')).toBe(true);
    expect(computeTokenCost('brand-new-model-x', { inputTokens: 1_000_000, outputTokens: 1_000_000 }))
      .toBeCloseTo(2 + 8, 6);
  });

  it('ignores non-finite overlay rates so a malformed registry cannot poison pricing', () => {
    registerModelRates({
      bad: { input: Number.NaN, output: 5 },
      worse: { input: 5, output: Number.POSITIVE_INFINITY },
    });
    expect(modelRateOverlaySize()).toBe(0);
    expect(getModelRate('bad')).toEqual(DEFAULT_MODEL_RATE);
  });

  it('clearModelRateOverlay restores snapshot/default behaviour', () => {
    registerModelRates({ [CLAUDE_MODELS.OPUS]: { input: 999, output: 1234 } });
    clearModelRateOverlay();
    expect(modelRateOverlaySize()).toBe(0);
    expect(getModelRate(CLAUDE_MODELS.OPUS)).toEqual(MODEL_PRICING[CLAUDE_MODELS.OPUS]);
  });
});
