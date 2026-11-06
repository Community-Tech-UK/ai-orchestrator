import { describe, expect, it } from 'vitest';
import { coerceRendererSettingValue, coerceWritableSettingValue } from './settings-control-policy';
import { PAUSE_SETTING_VALIDATORS } from './settings-validators';
import { DEFAULT_SETTINGS, SETTINGS_METADATA, type AppSettings } from '../../../shared/types/settings.types';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';
import { ADVANCED_SECTION_DEFINITIONS } from '../../../renderer/app/features/settings/advanced-settings-sections';
import type { TokenTrialSettings } from '../../../shared/types/token-trial-settings.types';

const settings: Pick<AppSettings, keyof TokenTrialSettings> = { codexCheckerSkillCatalog: 'trial' };
const choices = { codexCheckerSkillCatalog: ['trial', 'full', 'omit'] };
describe('checker skills-catalog setting on all seven surfaces', () => {
  it('extends AppSettings with a literal default', () => {
    expect(DEFAULT_SETTINGS).toMatchObject(settings);
  });
  it.each(Object.keys(settings) as Array<keyof TokenTrialSettings>)('%s is visible and validated on both write paths', key => {
    const meta = SETTINGS_METADATA.find(entry => entry.key === key);
    expect(meta?.type).toBe('select');
    expect(meta?.options?.map(option => option.value).sort()).toEqual([...choices[key]].sort());
    expect(SETTING_SURFACING[key]).toBe('tab');
    expect(ADVANCED_SECTION_DEFINITIONS.flatMap(section => [...section.keys])).toContain(key);
    for (const value of choices[key]) {
      expect(coerceWritableSettingValue(key, value).value).toBe(value);
      expect(coerceRendererSettingValue(key, value).value).toBe(value);
      expect(PAUSE_SETTING_VALIDATORS[key]?.(value)).toEqual({ ok: true, value });
    }
    for (const value of ['invalid-placeholder', '', null, 1, true]) {
      expect(() => coerceWritableSettingValue(key, value)).toThrow();
      expect(() => coerceRendererSettingValue(key, value)).toThrow();
      expect(PAUSE_SETTING_VALIDATORS[key]?.(value as never)?.ok).toBe(false);
    }
  });
});
