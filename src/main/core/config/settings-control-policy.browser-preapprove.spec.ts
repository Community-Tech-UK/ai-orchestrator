/**
 * 17 Nov 2026: whether agents may use agent-folder saved logins without asking
 * is James's decision. Closed on both the safe `set_setting` surface and the
 * privileged repair CLI, so an agent cannot approve its own sign-ins.
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
import { DEFAULT_SETTINGS } from '../../../shared/types/settings-defaults';
import { tabForSetting } from '../../../shared/types/settings-search-catalog';

const KEY = 'browserPreApproveAgentFolderLogins';

describe('agent-folder saved-login pre-approval setting policy', () => {
  it('is off by default', () => {
    expect(DEFAULT_SETTINGS[KEY]).toBe(false);
  });

  it('cannot be changed by an agent through either settings surface', () => {
    expect(getSettingsToolPolicy(KEY).tier).toBe('read-only');
    expect(() => coerceWritableSettingValue(KEY, true)).toThrow(/read-only/);
    expect(isPrivilegedSettingsCliWritable(KEY)).toBe(false);
    expect(() => assertPrivilegedSettingsCliWritable(KEY)).toThrow(/operator-only/);
  });

  it('shows on the Advanced settings tab and accepts the window\'s boolean write', () => {
    const meta = SETTINGS_METADATA.find((entry) => entry.key === KEY);
    expect(meta).toMatchObject({ type: 'boolean', category: 'advanced' });
    expect(meta?.hidden).not.toBe(true);
    expect(tabForSetting(meta!)).toBe('advanced');
    expect(coerceRendererSettingValue(KEY, true)).toEqual({ key: KEY, value: true });
  });
});
