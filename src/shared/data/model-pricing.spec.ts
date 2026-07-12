import { describe, it, expect, afterEach } from 'vitest';
import {
  computeTokenCost,
  getCacheWriteMultiplier,
  getModelRate,
  hasModelRate,
  registerModelRates,
  clearModelRateOverlay,
  modelRateOverlaySize,
  DEFAULT_MODEL_RATE,
} from './model-pricing';
import { CLAUDE_MODELS, MODEL_PRICING, OPENAI_MODELS } from '../types/provider.types';

describe('getCacheWriteMultiplier', () => {
  it('bills GPT-5.6 and later cache writes at 1.25x the input rate', () => {
    expect(getCacheWriteMultiplier(OPENAI_MODELS.GPT56_SOL)).toBe(1.25);
    expect(getCacheWriteMultiplier(OPENAI_MODELS.GPT56_TERRA)).toBe(1.25);
    expect(getCacheWriteMultiplier(OPENAI_MODELS.GPT56_LUNA)).toBe(1.25);
    // Version-compared, so a future release inherits the right billing.
    expect(getCacheWriteMultiplier('gpt-5.7')).toBe(1.25);
    expect(getCacheWriteMultiplier('gpt-6')).toBe(1.25);
  });

  it('bills pre-5.6 OpenAI and non-OpenAI cache writes at the plain input rate', () => {
    expect(getCacheWriteMultiplier(OPENAI_MODELS.GPT55)).toBe(1);
    expect(getCacheWriteMultiplier(OPENAI_MODELS.GPT53_CODEX)).toBe(1);
    expect(getCacheWriteMultiplier('gpt-5.4-mini')).toBe(1);
    expect(getCacheWriteMultiplier(CLAUDE_MODELS.OPUS)).toBe(1);
    expect(getCacheWriteMultiplier(undefined)).toBe(1);
    expect(getCacheWriteMultiplier('')).toBe(1);
  });

  it('applies the multiplier inside computeTokenCost', () => {
    const rate = MODEL_PRICING[OPENAI_MODELS.GPT56_TERRA];
    const cost = computeTokenCost(OPENAI_MODELS.GPT56_TERRA, { cacheWriteTokens: 1_000_000 });
    expect(cost).toBeCloseTo(rate.input * 1.25, 6);
  });
});

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

  it('prices reasoning tokens at the output-token rate', () => {
    const rate = MODEL_PRICING[CLAUDE_MODELS.OPUS];
    const cost = computeTokenCost(CLAUDE_MODELS.OPUS, {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(rate.output, 6);
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

  it('prices Claude Fable 5 at the documented Anthropic API rate', () => {
    expect(hasModelRate('claude-fable-5')).toBe(true);
    expect(getModelRate('claude-fable-5')).toEqual({ input: 10.0, output: 50.0 });
    expect(
      computeTokenCost('claude-fable-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(60, 6);
  });

  it('prices the GPT-5.6 preview family at the official static rates', () => {
    expect(getModelRate(OPENAI_MODELS.GPT56_SOL)).toEqual({ input: 5, output: 30 });
    expect(getModelRate(OPENAI_MODELS.GPT56_TERRA)).toEqual({ input: 2.5, output: 15 });
    expect(getModelRate(OPENAI_MODELS.GPT56_LUNA)).toEqual({ input: 1, output: 6 });
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
