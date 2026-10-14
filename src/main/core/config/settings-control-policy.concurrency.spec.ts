import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { coerceWritableSettingValue } from './settings-control-policy';

describe('provider concurrency settings control policy', () => {
  it('ships the built-in per-provider caps as the default', () => {
    expect(DEFAULT_SETTINGS.concurrencyLimitByProvider).toEqual({
      copilot: 10,
      cursor: 8,
      grok: 6,
      opencode: 20,
    });
  });

  it('accepts bounded integer caps per provider', () => {
    expect(coerceWritableSettingValue('concurrencyLimitByProvider', { opencode: 20 }).value)
      .toEqual({ opencode: 20 });
    expect(coerceWritableSettingValue('concurrencyLimitByProvider', {}).value).toEqual({});
  });

  it('rejects non-integer, out-of-range and malformed values', () => {
    expect(() => coerceWritableSettingValue('concurrencyLimitByProvider', { opencode: 0 })).toThrow();
    expect(() => coerceWritableSettingValue('concurrencyLimitByProvider', { opencode: 101 })).toThrow();
    expect(() => coerceWritableSettingValue('concurrencyLimitByProvider', { opencode: 10.5 })).toThrow();
    expect(() => coerceWritableSettingValue('concurrencyLimitByProvider', { opencode: '20' })).toThrow();
    expect(() => coerceWritableSettingValue('concurrencyLimitByProvider', 20)).toThrow();
    expect(() => coerceWritableSettingValue('concurrencyLimitByProvider', null)).toThrow();
    expect(() => coerceWritableSettingValue('concurrencyLimitByProvider', [])).toThrow();
  });
});
