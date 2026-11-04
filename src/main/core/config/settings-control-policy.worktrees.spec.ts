import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { coerceWritableSettingValue, getSettingsToolPolicy } from './settings-control-policy';

describe('worktree limit settings control policy', () => {
  it('defaults to 20 and lets agents change it without a restart', () => {
    expect(DEFAULT_SETTINGS.maxConcurrentWorktrees).toBe(20);
    expect(getSettingsToolPolicy('maxConcurrentWorktrees')).toMatchObject({ tier: 'open', restartRequired: false });
  });

  it('accepts whole numbers from 0 (no limit) to 100', () => {
    for (const value of [0, 1, 30, 100]) {
      expect(coerceWritableSettingValue('maxConcurrentWorktrees', value).value).toBe(value);
    }
  });

  it('rejects out-of-range and malformed values', () => {
    for (const value of [-1, 101, 2.5, '20', null]) {
      expect(() => coerceWritableSettingValue('maxConcurrentWorktrees', value)).toThrow();
    }
  });
});
