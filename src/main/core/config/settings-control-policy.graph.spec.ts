import { describe, expect, it } from 'vitest';
import { assertPrivilegedSettingsCliWritable } from './settings-control-policy';

describe('Microsoft Graph settings control policy', () => {
  it.each([
    'graphClientId',
    'graphAuthority',
    'graphScopesJson',
    'graphAgentWritableAccountsJson',
  ] as const)('keeps %s operator-only in privileged CLI mode', (key) => {
    expect(() => assertPrivilegedSettingsCliWritable(key)).toThrow(/operator-only/);
  });
});
