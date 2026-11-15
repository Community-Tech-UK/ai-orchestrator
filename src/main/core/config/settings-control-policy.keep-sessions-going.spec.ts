/**
 * `keepSessionsGoing` decides what Harness approves on the user's behalf, so it
 * must be writable only from the Settings screen: never the safe settings tool,
 * never the privileged `aio-mcp settings` repair CLI. An agent that could raise
 * it would be approving its own work.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings-defaults';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
} from './settings-control-policy';

describe('keepSessionsGoing settings control policy', () => {
  it('ships switched off', () => {
    expect(DEFAULT_SETTINGS.keepSessionsGoing).toBe('off');
  });

  it('is read-only tier with an explicit schema', () => {
    const policy = getSettingsToolPolicy('keepSessionsGoing');
    expect(policy.tier).toBe('read-only');
    expect(policy.schema).toBeDefined();
  });

  it('rejects the safe settings tool', () => {
    expect(() => coerceWritableSettingValue('keepSessionsGoing', 'own-suggestions')).toThrow(/read-only/);
  });

  it('rejects the privileged repair CLI', () => {
    expect(() => assertPrivilegedSettingsCliWritable('keepSessionsGoing')).toThrow(/operator-only/);
  });

  it.each(['off', 'flag-only', 'planned-work', 'clear-choices', 'own-suggestions'])('accepts %s from the Settings screen', (value) => {
    expect(coerceRendererSettingValue('keepSessionsGoing', value)).toEqual({ key: 'keepSessionsGoing', value });
  });

  it.each([true, 'on', 'everything', 3, null])('rejects %j from the Settings screen', (value) => {
    expect(() => coerceRendererSettingValue('keepSessionsGoing', value)).toThrow();
  });
});
