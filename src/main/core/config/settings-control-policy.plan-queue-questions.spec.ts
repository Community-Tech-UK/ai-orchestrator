import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../shared/types/settings.types';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';
import { coerceRendererSettingValue, coerceWritableSettingValue } from './settings-control-policy';
import { PAUSE_SETTING_VALIDATORS } from './settings-validators';
it('defaults queue questions to the queue page and exposes the two explicit destinations', () => {
  expect(DEFAULT_SETTINGS.planQueueQuestionsDestination).toBe('queue-page');
  expect(SETTING_SURFACING.planQueueQuestionsDestination).toBe('tab');
  const metadata = SETTINGS_METADATA.filter(row => row.key === 'planQueueQuestionsDestination');
  expect(metadata).toHaveLength(1);
  expect(metadata[0]).toMatchObject({ category: 'orchestration', options: [{ value: 'queue-page', label: 'The queue page' }, { value: 'parent-chat', label: 'The chat that started the run' }] });
});
it('validates both destination values on renderer, tool and stored-settings boundaries', () => {
  for (const value of ['queue-page', 'parent-chat']) {
    expect(coerceRendererSettingValue('planQueueQuestionsDestination', value).value).toBe(value);
    expect(coerceWritableSettingValue('planQueueQuestionsDestination', value).value).toBe(value);
    expect(PAUSE_SETTING_VALIDATORS.planQueueQuestionsDestination?.(value)).toEqual({ ok: true, value });
  }
  for (const value of ['', 'chat', true, {}]) {
    expect(() => coerceRendererSettingValue('planQueueQuestionsDestination', value)).toThrow();
    expect(() => coerceWritableSettingValue('planQueueQuestionsDestination', value)).toThrow();
    expect(PAUSE_SETTING_VALIDATORS.planQueueQuestionsDestination?.(value)?.ok).toBe(false);
  }
});
