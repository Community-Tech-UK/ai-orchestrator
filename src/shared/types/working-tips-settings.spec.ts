import { describe, expect, it } from 'vitest';
import { coerceRendererSettingValue, coerceWritableSettingValue } from '../../main/core/config/settings-control-policy';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from './settings.types';
import { SETTING_SURFACING } from './settings-surfacing';

describe('working tips display setting', () => {
  it('defaults on with a visible display control beside reasoning settings', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ showWorkingTips: true });
    expect(SETTING_SURFACING).toMatchObject({ showWorkingTips: 'tab' });
    const index = SETTINGS_METADATA.findIndex((entry) => entry.key === 'thinkingDefaultExpanded');
    expect(SETTINGS_METADATA[index + 1]).toMatchObject({ key: 'showWorkingTips', type: 'boolean', category: 'display' });
    expect(SETTINGS_METADATA[index + 1].description).toContain('At most two per launch');
  });
  it('allows booleans at renderer and tool write boundaries and refuses other types', () => {
    expect(coerceRendererSettingValue('showWorkingTips', false).value).toBe(false);
    expect(coerceWritableSettingValue('showWorkingTips', true).value).toBe(true);
    expect(() => coerceRendererSettingValue('showWorkingTips', 1)).toThrow();
  });
});
