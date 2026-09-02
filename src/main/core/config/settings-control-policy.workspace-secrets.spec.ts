import { describe, expect, it } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
  isPrivilegedSettingsCliWritable,
} from './settings-control-policy';

const KEYS = ['workspaceSecretsEnabled', 'workspaceSecretsAllowAgentRequests'] as const;

describe('workspace secret settings policy', () => {
  it('keeps both keys read-only on the safe set_setting surface', () => {
    for (const key of KEYS) {
      expect(getSettingsToolPolicy(key).tier).toBe('read-only');
      expect(() => coerceWritableSettingValue(key, false)).toThrow(/read-only/);
    }
  });

  it('refuses the privileged settings CLI so an agent cannot widen its own access', () => {
    for (const key of KEYS) {
      expect(isPrivilegedSettingsCliWritable(key), key).toBe(false);
      expect(() => assertPrivilegedSettingsCliWritable(key), key).toThrow(/operator-only/);
    }
  });
});
