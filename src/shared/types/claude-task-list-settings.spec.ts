import { describe, expect, it } from 'vitest';
import { coerceRendererSettingValue, coerceWritableSettingValue } from '../../main/core/config/settings-control-policy';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from './settings.types';
import { SETTING_SURFACING } from './settings-surfacing';

describe('Claude chat task-list setting', () => {
  it('defaults off and has a visible display settings row explaining the spawn scope', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ claudeShowTaskList: false });
    expect(SETTING_SURFACING).toMatchObject({ claudeShowTaskList: 'tab' });
    expect(SETTINGS_METADATA.filter((setting) => setting.key === 'claudeShowTaskList')).toHaveLength(1);
    const entry = SETTINGS_METADATA.find((setting) => setting.key === 'claudeShowTaskList');
    expect(entry).toMatchObject({ type: 'boolean', category: 'display' });
    expect(entry?.hidden).not.toBe(true);
    expect(entry?.description).toContain('new and restarted sessions');
    expect(entry?.description).toContain('Costs a small amount on every message');
    expect(entry?.description).toContain('shares the chat');
  });

  it('accepts boolean values through the setting write boundaries and rejects other values', () => {
    expect(coerceWritableSettingValue('claudeShowTaskList', true).value).toBe(true);
    expect(coerceRendererSettingValue('claudeShowTaskList', false).value).toBe(false);
    expect(() => coerceWritableSettingValue('claudeShowTaskList', 'true')).toThrow();
    expect(() => coerceRendererSettingValue('claudeShowTaskList', 1)).toThrow();
  });
});
