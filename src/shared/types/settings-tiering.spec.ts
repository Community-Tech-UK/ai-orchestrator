/**
 * S3.2 — the tier is derived from `SettingMetadata.type`, so these mostly guard
 * the exceptions and the fact that the derivation stays cheap and total.
 */
import { describe, expect, it } from 'vitest';

import { advancedToggleLabel, settingTier, splitByTier } from './settings-tiering';
import { SETTINGS_METADATA } from './settings.types';
import type { SettingMetadata } from './settings-metadata.types';

function meta(over: { key: string } & Partial<Omit<SettingMetadata, 'key'>>): SettingMetadata {
  return {
    label: 'A setting',
    description: 'What it does',
    type: 'boolean',
    category: 'general',
    ...over,
  } as unknown as SettingMetadata;
}

describe('settingTier', () => {
  it('treats a number as advanced — the tuning-knob rule', () => {
    expect(settingTier(meta({ key: 'someTimeoutMs', type: 'number' }))).toBe('advanced');
  });

  it('treats every non-numeric type as common', () => {
    for (const type of ['boolean', 'string', 'select', 'directory', 'multi-select', 'json'] as const) {
      expect(settingTier(meta({ key: 'k', type }))).toBe('common');
    }
  });

  it('exempts the three port settings, which are connectivity not tuning', () => {
    for (const key of ['remoteNodesServerPort', 'thinClientWsPort', 'mobileGatewayPort']) {
      expect(settingTier(meta({ key, type: 'number' }))).toBe('common');
    }
  });

  it('does not exempt other keys ending in Port', () => {
    expect(settingTier(meta({ key: 'somethingElsePort', type: 'number' }))).toBe('advanced');
  });

  it('classifies every real setting without throwing', () => {
    const tiers = new Set(SETTINGS_METADATA.map((m) => settingTier(m)));
    expect([...tiers].sort()).toEqual(['advanced', 'common']);
  });
});

describe('splitByTier', () => {
  it('splits into the two tiers', () => {
    const { common, advanced } = splitByTier([
      meta({ key: 'a', type: 'boolean' }),
      meta({ key: 'b', type: 'number' }),
    ]);
    expect(common.map((m) => m.key)).toEqual(['a']);
    expect(advanced.map((m) => m.key)).toEqual(['b']);
  });

  it('preserves the caller’s order within each tier', () => {
    const { advanced } = splitByTier([
      meta({ key: 'z', type: 'number' }),
      meta({ key: 'a', type: 'number' }),
    ]);
    // Not re-sorted: the tabs already order their rows meaningfully.
    expect(advanced.map((m) => m.key)).toEqual(['z', 'a']);
  });

  it('handles an empty list', () => {
    expect(splitByTier([])).toEqual({ common: [], advanced: [] });
  });

  it('loses nothing — every input lands in exactly one tier', () => {
    const { common, advanced } = splitByTier(SETTINGS_METADATA);
    expect(common.length + advanced.length).toBe(SETTINGS_METADATA.length);
  });
});

describe('advancedToggleLabel', () => {
  it('states the count so the toggle is worth opening', () => {
    expect(advancedToggleLabel(4, false)).toBe('4 more advanced settings — Show advanced');
  });

  it('says "setting" for one', () => {
    expect(advancedToggleLabel(1, false)).toBe('1 more advanced setting — Show advanced');
  });

  it('offers the way back when expanded', () => {
    expect(advancedToggleLabel(4, true)).toBe('Hide advanced settings');
  });
});
