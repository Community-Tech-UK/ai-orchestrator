// One describe per setting family. Each was its own one- or two-test file
// (context-evidence, live-permissions, notifications, plan-queue-questions,
// retrieval, token-trials, workspace-secrets); the tests are unchanged.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_METADATA, type AppSettings } from '../../../shared/types/settings.types';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';
import type { TokenTrialSettings } from '../../../shared/types/token-trial-settings.types';
import { ADVANCED_SECTION_DEFINITIONS } from '../../../renderer/app/features/settings/advanced-settings-sections';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
  isPrivilegedSettingsCliWritable,
} from './settings-control-policy';
import { PAUSE_SETTING_VALIDATORS } from './settings-validators';

describe('context evidence settings control policy', () => {
  it('allows the trusted operator renderer while keeping the agent tool surface read-only', () => {
    expect(getSettingsToolPolicy('contextEvidenceModeByProvider')).toMatchObject({
      tier: 'read-only',
      restartRequired: false,
    });
    expect(() => coerceWritableSettingValue(
      'contextEvidenceModeByProvider',
      { claude: 'shadow' },
    )).toThrow(/read-only/);
    expect(coerceRendererSettingValue(
      'contextEvidenceModeByProvider',
      { claude: 'shadow' },
    )).toEqual({
      key: 'contextEvidenceModeByProvider',
      value: { claude: 'shadow' },
    });
  });

  it('does not let the privileged agent CLI silently change rollout mode during a run', () => {
    expect(() => assertPrivilegedSettingsCliWritable('contextEvidenceModeByProvider'))
      .toThrow(/operator-only/);
  });
});

describe('live permission rollout setting', () => {
  it('ships off and permits only booleans on the trusted settings surface', () => {
    expect(DEFAULT_SETTINGS.claudeLivePermissionPrompts).toBe(false);
    expect(getSettingsToolPolicy('claudeLivePermissionPrompts').tier).toBe('read-only');
    expect(coerceRendererSettingValue('claudeLivePermissionPrompts', true).value).toBe(true);
    expect(() => coerceRendererSettingValue('claudeLivePermissionPrompts', 'true')).toThrow();
    expect(() => coerceWritableSettingValue('claudeLivePermissionPrompts', true)).toThrow();
  });
});

describe('notification settings control policy', () => {
  it('ships conservative cooldown and disabled quiet hours defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      notificationCooldownSeconds: 30,
      notificationQuietHoursEnabled: false,
      notificationQuietHoursStartHour: 22,
      notificationQuietHoursEndHour: 7,
    });
  });

  it('accepts only bounded cooldown and clock-hour settings', () => {
    expect(coerceWritableSettingValue('notificationCooldownSeconds', 15).value).toBe(15);
    expect(coerceWritableSettingValue('notificationQuietHoursEnabled', true).value).toBe(true);
    expect(coerceWritableSettingValue('notificationQuietHoursStartHour', 0).value).toBe(0);
    expect(coerceWritableSettingValue('notificationQuietHoursEndHour', 23).value).toBe(23);
    expect(() => coerceWritableSettingValue('notificationCooldownSeconds', -1)).toThrow();
    expect(() => coerceWritableSettingValue('notificationQuietHoursStartHour', 24)).toThrow();
  });
});

describe('plan queue questions destination setting', () => {
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
});

describe('memory notes retrieval setting', () => {
  it('surfaces the memory policy override as an editable boolean, default off', () => {
    expect(DEFAULT_SETTINGS.memoryNotesEveryMessage).toBe(false);
    expect(SETTING_SURFACING.memoryNotesEveryMessage).toBe('tab');
    expect(SETTINGS_METADATA.find(row => row.key === 'memoryNotesEveryMessage')).toMatchObject({ category: 'advanced', type: 'boolean' });
    expect(ADVANCED_SECTION_DEFINITIONS.some(section => section.keys.includes('memoryNotesEveryMessage'))).toBe(true);
    expect(coerceWritableSettingValue('memoryNotesEveryMessage', true).value).toBe(true);
    expect(() => coerceWritableSettingValue('memoryNotesEveryMessage', 'true')).toThrow();
  });
});

const tokenTrialSettings: Pick<AppSettings, keyof TokenTrialSettings> = { codexCheckerSkillCatalog: 'trial' };
const tokenTrialChoices = { codexCheckerSkillCatalog: ['trial', 'full', 'omit'] };
describe('checker skills-catalog setting on all seven surfaces', () => {
  it('extends AppSettings with a literal default', () => {
    expect(DEFAULT_SETTINGS).toMatchObject(tokenTrialSettings);
  });
  it.each(Object.keys(tokenTrialSettings) as (keyof TokenTrialSettings)[])('%s is visible and validated on both write paths', key => {
    const meta = SETTINGS_METADATA.find(entry => entry.key === key);
    expect(meta?.type).toBe('select');
    expect(meta?.options?.map(option => option.value).sort()).toEqual([...tokenTrialChoices[key]].sort());
    expect(SETTING_SURFACING[key]).toBe('tab');
    expect(ADVANCED_SECTION_DEFINITIONS.flatMap(section => [...section.keys])).toContain(key);
    for (const value of tokenTrialChoices[key]) {
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

const WORKSPACE_SECRET_KEYS = ['workspaceSecretsEnabled', 'workspaceSecretsAllowAgentRequests'] as const;

describe('workspace secret settings policy', () => {
  it('keeps both keys read-only on the safe set_setting surface', () => {
    for (const key of WORKSPACE_SECRET_KEYS) {
      expect(getSettingsToolPolicy(key).tier).toBe('read-only');
      expect(() => coerceWritableSettingValue(key, false)).toThrow(/read-only/);
    }
  });

  it('refuses the privileged settings CLI so an agent cannot widen its own access', () => {
    for (const key of WORKSPACE_SECRET_KEYS) {
      expect(isPrivilegedSettingsCliWritable(key), key).toBe(false);
      expect(() => assertPrivilegedSettingsCliWritable(key), key).toThrow(/operator-only/);
    }
  });
});
