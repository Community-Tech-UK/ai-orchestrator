import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { SETTINGS_METADATA } from '../../../shared/types/settings-metadata';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';
import { ADVANCED_SECTION_DEFINITIONS } from '../../../renderer/app/features/settings/advanced-settings-sections';
import { coerceWritableSettingValue } from './settings-control-policy';
it('surfaces the memory policy override as an editable boolean, default off', () => {
  expect(DEFAULT_SETTINGS.memoryNotesEveryMessage).toBe(false);
  expect(SETTING_SURFACING.memoryNotesEveryMessage).toBe('tab');
  expect(SETTINGS_METADATA.find(row => row.key === 'memoryNotesEveryMessage')).toMatchObject({ category: 'advanced', type: 'boolean' });
  expect(ADVANCED_SECTION_DEFINITIONS.some(section => section.keys.includes('memoryNotesEveryMessage'))).toBe(true);
  expect(coerceWritableSettingValue('memoryNotesEveryMessage', true).value).toBe(true);
  expect(() => coerceWritableSettingValue('memoryNotesEveryMessage', 'true')).toThrow();
});
