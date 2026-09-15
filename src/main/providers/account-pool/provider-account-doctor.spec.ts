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
