import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { coerceRendererSettingValue, coerceWritableSettingValue, getSettingsToolPolicy } from './settings-control-policy';

describe('live permission rollout setting', () => {
  it('ships off and permits only booleans on the trusted settings surface', () => {
    expect(DEFAULT_SETTINGS.claudeLivePermissionPrompts).toBe(false);
    expect(getSettingsToolPolicy('claudeLivePermissionPrompts').tier).toBe('read-only');
    expect(coerceRendererSettingValue('claudeLivePermissionPrompts', true).value).toBe(true);
    expect(() => coerceRendererSettingValue('claudeLivePermissionPrompts', 'true')).toThrow();
    expect(() => coerceWritableSettingValue('claudeLivePermissionPrompts', true)).toThrow();
  });
});
