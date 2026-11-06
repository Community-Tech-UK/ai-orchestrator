import { describe, expect, it } from 'vitest';
import { OPENAI_MODELS } from '../../shared/types/provider.types';
import {
  estimateFallbackCallUsd, fallbackPriceFor, resolveHelperDailyBudgetUsd,
  FALLBACK_HAIKU_MODEL, UNKNOWN_FALLBACK_COST_USD,
} from './helper-daily-budget';

describe('shared helper daily budget', () => {
  it('uses the fallback override, then the auxiliary limit, including zero', () => {
    expect(resolveHelperDailyBudgetUsd({
      localAiGuardDailyFallbackBudgetUsd: 2, auxiliaryLlmDailySpendCapUsd: 5,
    })).toBe(2);
    expect(resolveHelperDailyBudgetUsd({ auxiliaryLlmDailySpendCapUsd: 2 })).toBe(2);
    expect(resolveHelperDailyBudgetUsd({ localAiGuardDailyFallbackBudgetUsd: 0 })).toBe(0);
    expect(resolveHelperDailyBudgetUsd({})).toBeNull();
  });

  it('the auxiliary limit applies when the fallback budget is empty, and no limit when both are', () => {
    expect(resolveHelperDailyBudgetUsd({
      localAiGuardDailyFallbackBudgetUsd: null, auxiliaryLlmDailySpendCapUsd: 2,
    })).toBe(2);
    expect(resolveHelperDailyBudgetUsd({
      localAiGuardDailyFallbackBudgetUsd: null, auxiliaryLlmDailySpendCapUsd: null,
    })).toBeNull();
  });

  it('ignores a negative or non-finite setting rather than treating it as a limit', () => {
    expect(resolveHelperDailyBudgetUsd({
      localAiGuardDailyFallbackBudgetUsd: -1, auxiliaryLlmDailySpendCapUsd: 2,
    })).toBe(2);
    expect(resolveHelperDailyBudgetUsd({
      localAiGuardDailyFallbackBudgetUsd: Number.NaN, auxiliaryLlmDailySpendCapUsd: Number.POSITIVE_INFINITY,
    })).toBeNull();
  });

  it('prices CLI fallbacks at Haiku and an unkeyed summary rung at zero', () => {
    expect(fallbackPriceFor('routingClassification')).toEqual({
      provider: 'anthropic', model: FALLBACK_HAIKU_MODEL,
    });
    expect(fallbackPriceFor('compression', undefined, { anthropic: false, openai: false }))
      .toMatchObject({ fixedCostUsd: 0 });
    expect(fallbackPriceFor('compression', undefined, { anthropic: true, openai: false }))
      .toEqual({ provider: 'anthropic', model: FALLBACK_HAIKU_MODEL });
  });

  it('CLI-escalated slots are Haiku class whatever the default chat model or keys are', () => {
    const haiku = { provider: 'anthropic', model: FALLBACK_HAIKU_MODEL };
    expect(fallbackPriceFor('titleGeneration')).toEqual(haiku);
    expect(fallbackPriceFor('titleGeneration', undefined, { anthropic: false, openai: true })).toEqual(haiku);
  });

  it('summary-ladder slots are free without keys and use the key rung with one', () => {
    const none = { anthropic: false, openai: false };
    expect(fallbackPriceFor('compression', undefined, none)).toMatchObject({ fixedCostUsd: 0 });
    expect(fallbackPriceFor('memoryDistillation', undefined, none)).toMatchObject({ fixedCostUsd: 0 });
    expect(fallbackPriceFor('compression', undefined, { anthropic: false, openai: true }))
      .toEqual({ provider: 'openai', model: OPENAI_MODELS.GPT55_MINI });
    expect(fallbackPriceFor('compression', undefined, { anthropic: true, openai: true }))
      .toEqual({ provider: 'anthropic', model: FALLBACK_HAIKU_MODEL });
  });

  it('an intended provider and model always wins', () => {
    expect(fallbackPriceFor('titleGeneration', { provider: 'openai', model: 'gpt-4o-mini' }))
      .toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(fallbackPriceFor(
      'compression',
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { anthropic: true, openai: true },
    )).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('prices the rung model at the estimated tokens', () => {
    // Pinned Haiku is $1 per million input tokens and $5 per million output tokens.
    expect(estimateFallbackCallUsd(
      { provider: 'anthropic', model: FALLBACK_HAIKU_MODEL },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    )).toBeCloseTo(6, 6);
  });

  it('counts a missing or unpriced rung as a five-cent reservation', () => {
    const tokens = { inputTokens: 100, outputTokens: 20 };
    expect(estimateFallbackCallUsd(undefined, tokens)).toBe(UNKNOWN_FALLBACK_COST_USD);
    expect(estimateFallbackCallUsd({ provider: 'unknown', model: 'unknown' }, tokens)).toBe(0.05);
    expect(estimateFallbackCallUsd({ provider: 'ollama', model: 'local-summary', fixedCostUsd: 0 }, tokens)).toBe(0);
    expect(UNKNOWN_FALLBACK_COST_USD).toBe(0.05);
  });
});
