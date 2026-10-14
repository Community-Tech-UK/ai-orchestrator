import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from './settings.types';
import { SETTING_SURFACING } from './settings-surfacing';
import { SETTINGS_TOOL_POLICY, coerceWritableSettingValue } from '../../main/core/config/settings-control-policy';
describe('provider event recording setting', () => {
  it('is off by default, visible in memory settings, and changes without restarting', () => {
    expect(DEFAULT_SETTINGS.recordProviderEvents).toBe(false);
    expect(SETTING_SURFACING.recordProviderEvents).toBe('tab');
    expect(SETTINGS_METADATA.find((entry) => entry.key === 'recordProviderEvents')).toMatchObject({ category: 'memory', type: 'boolean' });
    expect(SETTINGS_TOOL_POLICY.recordProviderEvents.restartRequired).toBe(false);
    expect(coerceWritableSettingValue('recordProviderEvents', true).value).toBe(true);
    expect(() => coerceWritableSettingValue('recordProviderEvents', 'true')).toThrow('Invalid');
  });
});
