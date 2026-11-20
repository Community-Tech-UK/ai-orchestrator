/**
 * Whether agents may use agent-folder saved logins without asking. Closed on
 * the safe `set_setting` surface. Since 18 Nov 2026, at James's request, an
 * agent may change it through the privileged repair CLI (logged), like
 * `browserAllowSharedTabCredentialFill`.
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

  it('stays closed to the safe settings tool but opens to the privileged repair CLI', () => {
    expect(getSettingsToolPolicy(KEY).tier).toBe('read-only');
    expect(() => coerceWritableSettingValue(KEY, true)).toThrow(/read-only/);
    expect(isPrivilegedSettingsCliWritable(KEY)).toBe(true);
    expect(() => assertPrivilegedSettingsCliWritable(KEY)).not.toThrow();
  });

  it('shows on the Advanced settings tab and accepts the window\'s boolean write', () => {
    const meta = SETTINGS_METADATA.find((entry) => entry.key === KEY);
    expect(meta).toMatchObject({ type: 'boolean', category: 'advanced' });
    expect(meta?.hidden).not.toBe(true);
    expect(tabForSetting(meta!)).toBe('advanced');
    expect(coerceRendererSettingValue(KEY, true)).toEqual({ key: KEY, value: true });
  });
});
