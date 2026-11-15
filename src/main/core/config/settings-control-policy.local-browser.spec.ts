import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../shared/types/settings.types';
import { ADVANCED_SECTION_DEFINITIONS } from '../../../renderer/app/features/settings/advanced-settings-sections';
import { isPortableSettingKey } from './settings-export';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
} from './settings-control-policy';

const KEY = 'browserLocalComputerEnabled';

describe('offering this computer as a browser computer', () => {
  it('requires an operator choice on each computer', () => {
    expect(DEFAULT_SETTINGS.browserLocalComputerEnabled).toBe(false);
    expect(() => coerceWritableSettingValue(KEY, true)).toThrow(/read-only/);
    expect(() => assertPrivilegedSettingsCliWritable(KEY)).toThrow(/operator-only/);
    expect(coerceRendererSettingValue(KEY, true)).toEqual({ key: KEY, value: true });
    expect(isPortableSettingKey(KEY)).toBe(false);
  });

  it('shows the choice in Settings', () => {
    expect(SETTINGS_METADATA.find(entry => entry.key === KEY)).toMatchObject({
      type: 'boolean', category: 'advanced',
    });
    expect(ADVANCED_SECTION_DEFINITIONS.some(section => section.keys.includes(KEY))).toBe(true);
  });
});
