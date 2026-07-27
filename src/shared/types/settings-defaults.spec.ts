import { describe, expect, it } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
} from '../../main/core/config/settings-control-policy';
import { DEFAULT_SETTINGS } from './settings-defaults';
import { RUNTIME_SETTINGS_METADATA } from './settings-metadata-runtime';

const GUARD_SETTING_KEYS = [
  'localAiGuardDefaultFallbackPolicy',
  'localAiGuardDailyFallbackBudgetUsd',
  'localAiGuardConfirmAboveInputTokens',
] as const;

describe('Local AI Guard settings defaults and control policy', () => {
  it('ships compatibility-preserving fallback defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      localAiGuardDefaultFallbackPolicy: 'notify-and-allow',
      localAiGuardDailyFallbackBudgetUsd: null,
      localAiGuardConfirmAboveInputTokens: null,
    });
  });

  it('publishes operator metadata for every global fallback control', () => {
    const metadata = new Map(RUNTIME_SETTINGS_METADATA.map((entry) => [entry.key, entry]));

    expect(metadata.get('localAiGuardDefaultFallbackPolicy')).toMatchObject({
      type: 'select',
      category: 'advanced',
    });
    expect(metadata.get('localAiGuardDailyFallbackBudgetUsd')).toMatchObject({
      type: 'number',
      category: 'advanced',
      min: 0,
    });
    expect(metadata.get('localAiGuardConfirmAboveInputTokens')).toMatchObject({
      type: 'number',
      category: 'advanced',
      min: 0,
    });
  });

  it('keeps fallback controls operator-only on both agent mutation surfaces', () => {
    for (const key of GUARD_SETTING_KEYS) {
      expect(getSettingsToolPolicy(key)).toMatchObject({ tier: 'read-only' });
      expect(() => coerceWritableSettingValue(key, DEFAULT_SETTINGS[key])).toThrow(/read-only/);
      expect(() => assertPrivilegedSettingsCliWritable(key)).toThrow(/operator-only/);
    }
  });

  it('strictly validates trusted-renderer policy and nullable ceiling values', () => {
    expect(coerceRendererSettingValue(
      'localAiGuardDefaultFallbackPolicy',
      'require-confirmation',
    ).value).toBe('require-confirmation');
    expect(coerceRendererSettingValue('localAiGuardDailyFallbackBudgetUsd', 12.5).value).toBe(12.5);
    expect(coerceRendererSettingValue('localAiGuardDailyFallbackBudgetUsd', null).value).toBeNull();
    expect(coerceRendererSettingValue('localAiGuardConfirmAboveInputTokens', 10_000).value)
      .toBe(10_000);
    expect(coerceRendererSettingValue('localAiGuardConfirmAboveInputTokens', null).value).toBeNull();

    expect(() => coerceRendererSettingValue(
      'localAiGuardDefaultFallbackPolicy',
      'allow-everything',
    )).toThrow(/Invalid value/);
    expect(() => coerceRendererSettingValue('localAiGuardDailyFallbackBudgetUsd', -1))
      .toThrow(/Invalid value/);
    expect(() => coerceRendererSettingValue('localAiGuardDailyFallbackBudgetUsd', Number.NaN))
      .toThrow(/Invalid value/);
    expect(() => coerceRendererSettingValue('localAiGuardConfirmAboveInputTokens', 1.5))
      .toThrow(/Invalid value/);
  });
});
