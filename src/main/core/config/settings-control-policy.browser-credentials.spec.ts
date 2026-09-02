/**
 * 2026-08-29 deliberate widening, authorised by the operator.
 *
 * `browserVaultMasterPasswordFile`, `browserVaultAutoUnlock` and
 * `browserAllowSharedTabCredentialFill` were the complete set of settings
 * standing between an agent and an unattended portal login. They were moved off
 * PRIVILEGED_CLI_OPERATOR_ONLY_KEYS so the privileged `aio-mcp settings` CLI can
 * write them.
 *
 * This spec pins the two halves of that decision so neither drifts:
 *   1. the three keys ARE writable through the privileged repair CLI, and
 *   2. they remain closed to the safe `set_setting` MCP tool surface, and every
 *      other operator-only anchor is untouched.
 *
 * Follows the precedent of settings-control-policy.pr-creation.spec.ts: a
 * change to the authorization boundary gets a named spec recording why.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
  isPrivilegedSettingsCliWritable,
} from './settings-control-policy';

const WIDENED_KEYS = [
  'browserVaultMasterPasswordFile',
  'browserVaultAutoUnlock',
  'browserAllowSharedTabCredentialFill',
] as const;

describe('browser credential settings: 2026-08-29 privileged-CLI widening', () => {
  it('allows the privileged repair CLI to write all three', () => {
    for (const key of WIDENED_KEYS) {
      expect(isPrivilegedSettingsCliWritable(key), key).toBe(true);
      expect(() => assertPrivilegedSettingsCliWritable(key)).not.toThrow();
    }
  });

  it('still refuses the safe MCP tool surface for all three', () => {
    // The widening is scoped to the privileged local CLI. An agent calling the
    // ordinary set_setting tool must still be refused, so the boundary moved
    // one step rather than being removed.
    expect(() => coerceWritableSettingValue('browserVaultAutoUnlock', true))
      .toThrow(/read-only/);
    expect(() => coerceWritableSettingValue('browserAllowSharedTabCredentialFill', true))
      .toThrow(/read-only/);
    expect(() => coerceWritableSettingValue('browserVaultMasterPasswordFile', '/tmp/pw'))
      .toThrow(/secret/);
  });

  it('keeps the master password file on the secret tier so its value stays redacted', () => {
    expect(getSettingsToolPolicy('browserVaultMasterPasswordFile').tier).toBe('secret');
    expect(getSettingsToolPolicy('browserVaultAutoUnlock').tier).toBe('read-only');
    expect(getSettingsToolPolicy('browserAllowSharedTabCredentialFill').tier).toBe('read-only');
  });

  it('accepts well-formed privileged writes and rejects malformed ones', () => {
    expect(coerceRendererSettingValue('browserVaultAutoUnlock', true))
      .toEqual({ key: 'browserVaultAutoUnlock', value: true });
    expect(coerceRendererSettingValue('browserAllowSharedTabCredentialFill', false))
      .toEqual({ key: 'browserAllowSharedTabCredentialFill', value: false });
    expect(coerceRendererSettingValue('browserVaultMasterPasswordFile', '/Users/x/pw.txt'))
      .toEqual({ key: 'browserVaultMasterPasswordFile', value: '/Users/x/pw.txt' });

    // Primitive type gate still applies: a boolean key cannot take a string.
    expect(() => coerceRendererSettingValue('browserVaultAutoUnlock', 'yes')).toThrow();
    expect(() => coerceRendererSettingValue('browserVaultMasterPasswordFile', 42)).toThrow();
  });

  it('leaves every other operator-only anchor refused', () => {
    // Regression guard for the actual risk of this change: that a later edit
    // widens the set wholesale instead of these three keys.
    for (const key of [
      'allowPrCreation',
      'providersExcludedFromAutomation',
      'copilotAccountProfiles',
      'copilotAccountRoutingRules',
      'computerUseEnabled',
      'computerUseAutonomyLevel',
      'computerUseAllowedAppsJson',
      'computerUseDeniedAppsJson',
      'computerUseRequireApprovalForInput',
      'computerUseStoreScreenshotsForEscalations',
      'contextEvidenceModeByProvider',
      'graphClientId',
      'graphAuthority',
      'graphScopesJson',
      'graphAgentWritableAccountsJson',
      'localAiGuardDefaultFallbackPolicy',
      'localAiGuardDailyFallbackBudgetUsd',
      'localAiGuardConfirmAboveInputTokens',
      'workspaceSecretsEnabled',
      'workspaceSecretsAllowAgentRequests',
    ] as const) {
      expect(isPrivilegedSettingsCliWritable(key), key).toBe(false);
      expect(() => assertPrivilegedSettingsCliWritable(key), key).toThrow(/operator-only/);
    }
  });
});
