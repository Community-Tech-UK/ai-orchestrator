import { describe, expect, it } from 'vitest';
import { coerceRendererSettingValue, coerceWritableSettingValue } from './settings-control-policy';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../shared/types/settings.types';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';

describe('Claude successful command output setting', () => {
  it('defaults to 12000 and is visible in the settings tab', () => {
    expect(DEFAULT_SETTINGS.claudeBashOutputMaxChars).toBe(12_000);
    expect(SETTING_SURFACING.claudeBashOutputMaxChars).toBe('tab');
    expect(SETTINGS_METADATA.find(entry => entry.key === 'claudeBashOutputMaxChars')).toMatchObject({ type: 'number', min: 0, max: 128_000 });
  });
  it('accepts the provider default or a supported cap on both write surfaces', () => {
    for (const cap of [0, 4_000, 12_000, 128_000]) {
      expect(coerceWritableSettingValue('claudeBashOutputMaxChars', cap).value).toBe(cap);
      expect(coerceRendererSettingValue('claudeBashOutputMaxChars', cap).value).toBe(cap);
    }
  });
  it.each([-1, 1, 3_999, 128_001, 4_000.5, NaN, Infinity])('rejects invalid cap %s', cap => {
    expect(() => coerceWritableSettingValue('claudeBashOutputMaxChars', cap)).toThrow();
    expect(() => coerceRendererSettingValue('claudeBashOutputMaxChars', cap)).toThrow();
  });
});
