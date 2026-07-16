import { describe, expect, it } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
} from './settings-control-policy';

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
