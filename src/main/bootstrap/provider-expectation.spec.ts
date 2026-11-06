import { describe, expect, it } from 'vitest';
import type { CopilotAccountProfile } from '../../shared/types/copilot-account.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { providerExpectation, type ProviderExpectationSettings } from './provider-expectation';

function account(overrides: Partial<ProviderAccountProfile>): ProviderAccountProfile {
  return {
    id: 'work',
    provider: 'codex',
    label: 'Work',
    expectedIdentity: null,
    expectedAccountKey: null,
    planLabel: null,
    priority: 0,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function copilotAccount(overrides: Partial<CopilotAccountProfile>): CopilotAccountProfile {
  return {
    id: 'work',
    label: 'Work',
    expectedLogin: null,
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function settings(overrides: Partial<ProviderExpectationSettings> = {}): ProviderExpectationSettings {
  return {
    defaultCli: 'auto',
    automationDefaultCli: 'auto',
    providerAccountProfiles: [],
    copilotAccountProfiles: [],
    ...overrides,
  };
}

describe('providerExpectation', () => {
  it('expects nothing on a fresh install, so an uninstalled tool stays quiet', () => {
    for (const id of ['claude', 'codex', 'antigravity', 'copilot', 'cursor'] as const) {
      expect(providerExpectation(id, settings())).toBeNull();
    }
  });

  it('expects nothing when settings cannot be read', () => {
    expect(providerExpectation('cursor', null)).toBeNull();
  });

  it('expects the tool you chose as your default', () => {
    expect(providerExpectation('cursor', settings({ defaultCli: 'cursor' }))).toBe('default');
    expect(providerExpectation('claude', settings({ defaultCli: 'cursor' }))).toBeNull();
  });

  it('expects the tool you chose for automations', () => {
    expect(providerExpectation('codex', settings({ automationDefaultCli: 'codex' }))).toBe('default');
  });

  it('reads the old "openai" default as Codex', () => {
    expect(providerExpectation('codex', settings({ defaultCli: 'openai' }))).toBe('default');
  });

  it('expects a tool once you have added an account for it', () => {
    const added = settings({ providerAccountProfiles: [account({ provider: 'codex' })] });
    expect(providerExpectation('codex', added)).toBe('account');
    expect(providerExpectation('claude', added)).toBeNull();
  });

  it('ignores an account that is switched off', () => {
    const off = settings({ providerAccountProfiles: [account({ enabled: false })] });
    expect(providerExpectation('codex', off)).toBeNull();
  });

  it('does not count the account Harness creates by itself for Claude and Codex', () => {
    const automatic = settings({
      providerAccountProfiles: [
        account({ id: 'legacy', provider: 'claude', isLegacy: true }),
        account({ id: 'legacy', provider: 'codex', isLegacy: true }),
      ],
    });
    expect(providerExpectation('claude', automatic)).toBeNull();
    expect(providerExpectation('codex', automatic)).toBeNull();
  });

  it('counts that automatic account once someone has actually signed in through it', () => {
    const signedIn = settings({
      providerAccountProfiles: [
        account({ id: 'legacy', provider: 'claude', isLegacy: true, expectedIdentity: 'me@example.com' }),
      ],
    });
    expect(providerExpectation('claude', signedIn)).toBe('account');
  });

  it('applies the same rules to Copilot accounts', () => {
    expect(providerExpectation('copilot', settings({
      copilotAccountProfiles: [copilotAccount({ id: 'legacy', isLegacy: true })],
    }))).toBeNull();
    expect(providerExpectation('copilot', settings({
      copilotAccountProfiles: [copilotAccount({ id: 'legacy', isLegacy: true, expectedLogin: 'someone' })],
    }))).toBe('account');
    expect(providerExpectation('copilot', settings({
      copilotAccountProfiles: [copilotAccount({})],
    }))).toBe('account');
  });

  it('has no accounts to go on for Cursor or Antigravity, only a default', () => {
    const withAccounts = settings({
      providerAccountProfiles: [account({ provider: 'codex' })],
      copilotAccountProfiles: [copilotAccount({})],
    });
    expect(providerExpectation('cursor', withAccounts)).toBeNull();
    expect(providerExpectation('antigravity', withAccounts)).toBeNull();
    expect(providerExpectation('antigravity', settings({ defaultCli: 'antigravity' }))).toBe('default');
  });
});
