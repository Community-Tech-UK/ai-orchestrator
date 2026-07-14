import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { coerceWritableSettingValue } from './settings-control-policy';

describe('reviewer settings control policy', () => {
  it('accepts all six canonical remote reviewer providers in one priority list', () => {
    const result = coerceWritableSettingValue(
      'crossModelReviewProviders',
      ['claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok'],
    );

    expect(result.value).toHaveLength(6);
  });

  it.each(['claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok'])(
    'accepts %s as a remote reviewer provider',
    (provider) => {
      expect(coerceWritableSettingValue('crossModelReviewProviders', [provider]).value)
        .toEqual([provider]);
    },
  );

  it('rejects unknown remote reviewer providers', () => {
    expect(() => coerceWritableSettingValue(
      'crossModelReviewProviders',
      ['codex', 'not-a-reviewer'],
    )).toThrow(/Invalid value for crossModelReviewProviders/);
  });

  it('accepts Grok as the ping-pong reviewer provider', () => {
    expect(coerceWritableSettingValue('pingPongReviewerProvider', 'grok').value).toBe('grok');
  });

  it('provides defaults for local review settings', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      crossModelReviewLocalEnabled: true,
      crossModelReviewLocalSelectorId: '',
      crossModelReviewLocalTimeout: 120,
      crossModelReviewLocalMaxToolRounds: 12,
    });
  });

  it('accepts an optional non-negative auxiliary daily spend cap', () => {
    expect(coerceWritableSettingValue('auxiliaryLlmDailySpendCapUsd', 0.25).value).toBe(0.25);
    expect(coerceWritableSettingValue('auxiliaryLlmDailySpendCapUsd', null).value).toBeNull();
    expect(() => coerceWritableSettingValue('auxiliaryLlmDailySpendCapUsd', -0.01))
      .toThrow('Invalid value for auxiliaryLlmDailySpendCapUsd');
  });

  it('keeps quota pacing operator-configurable within safe percentage bounds', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      quotaPacingWarningEnabled: true,
      quotaPacingUtilizationThresholdPercent: 90,
      quotaPacingLatestElapsedPercent: 72,
    });
    expect(coerceWritableSettingValue('quotaPacingWarningEnabled', false).value).toBe(false);
    expect(coerceWritableSettingValue('quotaPacingUtilizationThresholdPercent', 85).value).toBe(85);
    expect(coerceWritableSettingValue('quotaPacingLatestElapsedPercent', 60).value).toBe(60);
    expect(() => coerceWritableSettingValue('quotaPacingUtilizationThresholdPercent', 101))
      .toThrow('Invalid value for quotaPacingUtilizationThresholdPercent');
    expect(() => coerceWritableSettingValue('quotaPacingLatestElapsedPercent', -1))
      .toThrow('Invalid value for quotaPacingLatestElapsedPercent');
  });

  it.each([
    ['crossModelReviewLocalEnabled', true],
    ['crossModelReviewLocalSelectorId', 'lm://worker-node/node-1/ollama/ollama/qwen'],
    ['crossModelReviewLocalTimeout', 10],
    ['crossModelReviewLocalTimeout', 600],
    ['crossModelReviewLocalMaxToolRounds', 1],
    ['crossModelReviewLocalMaxToolRounds', 32],
  ])('accepts valid %s values', (key, value) => {
    expect(coerceWritableSettingValue(key, value).value).toEqual(value);
  });

  it.each([
    ['crossModelReviewLocalTimeout', 9],
    ['crossModelReviewLocalTimeout', 601],
    ['crossModelReviewLocalTimeout', 10.5],
    ['crossModelReviewLocalMaxToolRounds', 0],
    ['crossModelReviewLocalMaxToolRounds', 33],
    ['crossModelReviewLocalMaxToolRounds', 1.5],
  ])('rejects invalid %s values', (key, value) => {
    expect(() => coerceWritableSettingValue(key, value)).toThrow(`Invalid value for ${key}`);
  });
});
