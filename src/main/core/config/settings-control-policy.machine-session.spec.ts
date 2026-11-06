import { describe, expect, it } from 'vitest';
import {
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
} from './settings-control-policy';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../shared/types/settings.types';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';

const metadata = new Map(SETTINGS_METADATA.map((entry) => [entry.key, entry]));

describe('Phase 1 settings', () => {
  it('reports RTK preferences as applying without an app restart', () => {
    for (const key of ['rtkEnabled', 'rtkBundledOnly'] as const) {
      expect(getSettingsToolPolicy(key).restartRequired).toBe(false);
      expect(coerceWritableSettingValue(key, false).policy.restartRequired).toBe(false);
      expect(coerceRendererSettingValue(key, true).value).toBe(true);
    }
  });

  it('ships both ceilings on Claude\'s own limit and enforces the CLI range on both write surfaces', () => {
    expect(DEFAULT_SETTINGS.ownChatContextCeilingTokens).toBe(0);
    expect(DEFAULT_SETTINGS.machineContextCeilingTokens).toBe(0);
    for (const key of ['ownChatContextCeilingTokens', 'machineContextCeilingTokens'] as const) {
      expect(SETTING_SURFACING[key]).toBe('tab');
      expect(getSettingsToolPolicy(key).restartRequired).toBe(false);
      for (const value of [0, 100_000, 1_000_000]) {
        expect(coerceWritableSettingValue(key, value).value).toBe(value);
        expect(coerceRendererSettingValue(key, value).value).toBe(value);
      }
      for (const value of [1, 50_000, 99_999, 1_000_001, NaN]) {
        expect(() => coerceWritableSettingValue(key, value)).toThrow();
        expect(() => coerceRendererSettingValue(key, value)).toThrow();
      }
    }
  });

  it('exposes one validated Codex helper and tuning choice per setting', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      codexHelperAgentsChats: 'trial',
      codexHelperAgentsHarnessWork: 'trial',
      codexContextTuning: 'harness',
    });
    for (const key of ['codexHelperAgentsChats', 'codexHelperAgentsHarnessWork', 'codexContextTuning'] as const) {
      expect(SETTING_SURFACING[key]).toBe('tab');
      expect(metadata.get(key)?.type).toBe('select');
      expect(getSettingsToolPolicy(key).restartRequired).toBe(false);
      expect(SETTINGS_METADATA.filter((entry) => entry.key === key)).toHaveLength(1);
    }
    expect(coerceWritableSettingValue('codexContextTuning', 'codex').value).toBe('codex');
    expect(() => coerceWritableSettingValue('codexHelperAgentsHarnessWork', 'economy')).toThrow();
  });

  it('validates the Claude helper model and Bash output cap without requiring an app restart', () => {
    expect(DEFAULT_SETTINGS.claudeHelperAgentModel).toBe('trial');
    expect(DEFAULT_SETTINGS.claudeBashOutputMaxChars).toBe(12_000);
    expect(coerceWritableSettingValue('claudeHelperAgentModel', 'sonnet').value).toBe('sonnet');
    expect(() => coerceWritableSettingValue('claudeHelperAgentModel', 'opus')).toThrow();
    for (const value of [0, 4_000, 12_000, 128_000]) {
      expect(coerceWritableSettingValue('claudeBashOutputMaxChars', value).value).toBe(value);
      expect(coerceRendererSettingValue('claudeBashOutputMaxChars', value).value).toBe(value);
    }
    for (const value of [1, 3_999, 128_001, 12_000.5, NaN]) {
      expect(() => coerceWritableSettingValue('claudeBashOutputMaxChars', value)).toThrow();
      expect(() => coerceRendererSettingValue('claudeBashOutputMaxChars', value)).toThrow();
    }
    for (const key of ['claudeHelperAgentModel', 'claudeBashOutputMaxChars'] as const) {
      expect(SETTING_SURFACING[key]).toBe('tab');
      expect(metadata.get(key)).toBeDefined();
      expect(getSettingsToolPolicy(key).restartRequired).toBe(false);
    }
  });

  it('offers cold-cache compaction while enabled and ships the RTK auto-approve scope off until Live check 1 has fully passed', () => {
    expect(DEFAULT_SETTINGS.coldCacheCompactFirst).toBe(true);
    expect(DEFAULT_SETTINGS.rtkAutoApproveScope).toBe('off');
    expect(coerceWritableSettingValue('coldCacheCompactFirst', false).value).toBe(false);
    expect(() => coerceWritableSettingValue('coldCacheCompactFirst', 'false')).toThrow();
    for (const scope of ['off', 'trial', 'on', 'sessions-only']) {
      expect(coerceWritableSettingValue('rtkAutoApproveScope', scope).value).toBe(scope);
    }
    expect(() => coerceWritableSettingValue('rtkAutoApproveScope', 'all')).toThrow();
    for (const key of ['coldCacheCompactFirst', 'rtkAutoApproveScope'] as const) {
      expect(SETTING_SURFACING[key]).toBe('tab');
      expect(metadata.get(key)).toBeDefined();
      expect(getSettingsToolPolicy(key).restartRequired).toBe(false);
    }
  });
});
