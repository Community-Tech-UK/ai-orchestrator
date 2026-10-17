/**
 * 2026-10-16: the macOS session signal fence switch is James-only.
 *
 * `providerSignalFenceEnabled` lets sessions signal programs outside their own
 * sandbox. An agent that could flip it could kill sibling sessions. Closed on
 * both the safe `set_setting` surface and the privileged repair CLI.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
  isPrivilegedSettingsCliWritable,
} from './settings-control-policy';
import { SETTINGS_METADATA } from '../../../shared/types/settings.types';
import { tabForSetting } from '../../../shared/types/settings-search-catalog';

const KEY = 'providerSignalFenceEnabled';

describe('provider signal fence setting policy', () => {
  it('keeps the key read-only on the safe set_setting surface', () => {
    expect(getSettingsToolPolicy(KEY).tier).toBe('read-only');
    expect(() => coerceWritableSettingValue(KEY, false)).toThrow(/read-only/);
    expect(() => coerceWritableSettingValue(KEY, true)).toThrow(/read-only/);
  });

  it('refuses the privileged settings CLI so an agent cannot lift the fence', () => {
    expect(isPrivilegedSettingsCliWritable(KEY)).toBe(false);
    expect(() => assertPrivilegedSettingsCliWritable(KEY)).toThrow(/operator-only/);
  });

  it('surfaces on the Advanced settings tab so search can land on the row', () => {
    const meta = SETTINGS_METADATA.find((entry) => entry.key === KEY);
    expect(meta).toMatchObject({ type: 'boolean', category: 'advanced' });
    expect(meta?.hidden).not.toBe(true);
    expect(tabForSetting(meta!)).toBe('advanced');
  });

  it('accepts a trusted-renderer boolean write', () => {
    expect(coerceRendererSettingValue(KEY, false)).toEqual({ key: KEY, value: false });
    expect(coerceRendererSettingValue(KEY, true)).toEqual({ key: KEY, value: true });
    expect(() => coerceRendererSettingValue(KEY, 'off')).toThrow();
  });
});
