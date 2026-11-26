import { describe, expect, it } from 'vitest';
import { coerceRendererSettingValue, getSettingsToolPolicy } from '../../main/core/config/settings-control-policy';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from './settings.types';
import { SETTING_SURFACING } from './settings-surfacing';

describe('follow-up settings switches', () => {
  it.each(['injectRepoMap', 'transcriptVirtualization'] as const)('offers %s with its existing typed default and boolean write policy', (key) => {
    expect(typeof DEFAULT_SETTINGS[key]).toBe('boolean');
    expect(SETTING_SURFACING[key]).toBe('tab');
    expect(SETTINGS_METADATA.find((row) => row.key === key)).toMatchObject({ type: 'boolean', category: 'advanced' });
    expect(SETTINGS_METADATA.filter((row) => row.key === key)).toHaveLength(1);
    expect(getSettingsToolPolicy(key).tier).toBe('open');
    expect(coerceRendererSettingValue(key, true)).toEqual({ key, value: true });
    expect(coerceRendererSettingValue(key, false)).toEqual({ key, value: false });
    expect(() => coerceRendererSettingValue(key, 'invalid')).toThrow();
    expect(SETTINGS_METADATA.find((row) => row.key === key)?.requiresRestart).not.toBe(true);
  });

  it('preserves defaults and the other three switches existing surfaces', () => {
    expect(DEFAULT_SETTINGS.injectRepoMap).toBe(true);
    expect(DEFAULT_SETTINGS.transcriptVirtualization).toBe(false);
    expect(SETTING_SURFACING.detectDegradedAdapterOutput).toBe('internal');
    expect(SETTING_SURFACING.enableSpawnWorkerOffload).toBe('internal');
    expect(SETTING_SURFACING.toolLoopAutoInterrupt).toBe('bespoke');
    expect(SETTINGS_METADATA.some((row) => row.key === 'detectDegradedAdapterOutput' || row.key === 'enableSpawnWorkerOffload' || row.key === 'toolLoopAutoInterrupt')).toBe(false);
    expect(SETTINGS_METADATA.find((row) => row.key === 'transcriptVirtualization')?.stage).toBe('experimental');
  });
});
