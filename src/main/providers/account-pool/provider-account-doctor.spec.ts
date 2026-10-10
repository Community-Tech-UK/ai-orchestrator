import { describe, expect, it, vi } from 'vitest';
import type { AccountBindingStatus, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => {
    throw new Error('not reached');
  },
}));

import { buildProviderAccountDoctorReport, summarizeProviderAccountReport } from './provider-account-doctor';
import { ProviderAccountStore } from './provider-account-store';
import type { ProviderAccountBindingService } from './provider-account-binding-service';

function profile(id: string, priority: number, accountKey: string | null = null): ProviderAccountProfile {
  return {
    id, provider: 'codex', label: `Label ${id}`, expectedIdentity: null, expectedAccountKey: accountKey, planLabel: null,
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  };
}

function bindings(states: Record<string, AccountBindingStatus['state']>): ProviderAccountBindingService {
  return {
    checkBinding: async (entry: ProviderAccountProfile) => ({ provider: 'codex', profileId: entry.id, nodeId: 'local', state: states[entry.id] ?? 'authenticated', checkedAt: 1 }),
    getObservedIdentity: () => null,
  } as unknown as ProviderAccountBindingService;
}

describe('buildProviderAccountDoctorReport', () => {
  it('reports usable profiles, shared workspaces, ambient variable names and warnings', async () => {
    const store = new ProviderAccountStore({
      read: () => ({ profiles: [profile('legacy', 0, 'acct-1'), profile('pro-b', 1, 'acct-1'), profile('pro-c', 2)], pools: defaultProviderAccountPools() }),
    });
    const report = await buildProviderAccountDoctorReport('codex', {
      store,
      bindings: bindings({ 'pro-c': 'unauthenticated' }),
      env: { OPENAI_API_KEY: 'placeholder-value' },
    });
    expect(report.poolActive).toBe(true);
    expect(report.usableProfileIds).toEqual(['legacy', 'pro-b']);
    expect(report.sharedWorkspaceProfileIds).toEqual(['legacy', 'pro-b']);
    expect(report.ambientAuthVariablesPresent).toEqual(['OPENAI_API_KEY']);
    expect(JSON.stringify(report)).not.toContain('placeholder-value');
    expect(report.warnings.join(' ')).toMatch(/Label pro-c needs attention: unauthenticated/);
    expect(summarizeProviderAccountReport(report)).toMatch(/2 of 3 accounts usable/);
  });

  it('describes a legacy-only install as a single account', async () => {
    const store = new ProviderAccountStore({ read: () => ({ profiles: [profile('legacy', 0)], pools: defaultProviderAccountPools() }) });
    const report = await buildProviderAccountDoctorReport('codex', { store, bindings: bindings({}), env: {} });
    expect(report.poolActive).toBe(false);
    expect(report.warnings).toEqual([]);
  });
});

describe('buildProviderAccountDoctorReport for MiMo accounts', () => {
  function mimoProfile(id: string, priority: number, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
    return {
      id, provider: 'opencode', label: `MiMo ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
      priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy',
      region: 'ams', createdAt: 1, updatedAt: 1, ...overrides,
    };
  }

  it('flags accounts with no key and non-legacy accounts with no model metadata', async () => {
    const store = new ProviderAccountStore({
      read: () => ({
        profiles: [mimoProfile('legacy', 0), mimoProfile('max-b-1a2b', 1), mimoProfile('max-c-2b3c', 2, { region: 'sgp' })],
        pools: defaultProviderAccountPools(),
      }),
    });
    const report = await buildProviderAccountDoctorReport('opencode', {
      store,
      bindings: bindings({ 'max-b-1a2b': 'unauthenticated' }),
      env: {},
      getRegionModelMetadata: (region) => (region === 'ams' ? [{}] : []),
    });
    expect(report.usableProfileIds).toEqual(['legacy', 'max-c-2b3c']);
    expect(report.ambientAuthVariablesPresent).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/MiMo max-b-1a2b needs attention: unauthenticated/);
    expect(report.warnings.join(' ')).toMatch(/MiMo max-c-2b3c has no model metadata for xiaomi-token-plan-sgp/);
    // The legacy account uses OpenCode's own provider and needs no metadata copy.
    expect(report.warnings.join(' ')).not.toMatch(/MiMo legacy has no model metadata/);
  });

  it('warns about nothing on a healthy MiMo pool', async () => {
    const store = new ProviderAccountStore({
      read: () => ({ profiles: [mimoProfile('legacy', 0), mimoProfile('max-b-1a2b', 1)], pools: defaultProviderAccountPools() }),
    });
    const report = await buildProviderAccountDoctorReport('opencode', {
      store,
      bindings: bindings({}),
      env: {},
      getRegionModelMetadata: () => [{}],
    });
    expect(report.warnings.join(' ')).not.toMatch(/needs attention|no model metadata/);
  });
});
