import { describe, expect, it } from 'vitest';
import type { ProviderQuotaSnapshot } from '../types/provider-quota.types';
import { quotaAccountSections, type QuotaAccountProfile } from './provider-quota-account-sections';

function snapshot(accountProfileId?: string): ProviderQuotaSnapshot {
  return {
    provider: 'opencode', takenAt: 1, source: 'admin-api', ok: true, windows: [],
    ...(accountProfileId ? { accountProfileId } : {}),
  };
}

function profile(id: string, priority: number): QuotaAccountProfile {
  return { id, provider: 'opencode', label: id === 'legacy' ? 'SuasMimo' : 'ComTechMimo', enabled: true, isLegacy: id === 'legacy', priority };
}

describe('quotaAccountSections', () => {
  it('lists the existing sign-in first, then added accounts, all labelled', () => {
    const sections = quotaAccountSections('opencode', snapshot(), [snapshot('comtech-1a2b')], [profile('comtech-1a2b', 0), profile('legacy', 1)]);
    expect(sections.map((section) => [section.id, section.label])).toEqual([['legacy', 'SuasMimo'], ['comtech-1a2b', 'ComTechMimo']]);
  });

  it('drops the existing sign-in once it has been removed from the accounts', () => {
    const sections = quotaAccountSections('opencode', snapshot(), [snapshot('comtech-1a2b')], [profile('comtech-1a2b', 0)]);
    expect(sections.map((section) => [section.id, section.label])).toEqual([['comtech-1a2b', 'ComTechMimo']]);
  });

  it('keeps the provider-wide reading while accounts are unknown or none are set up', () => {
    expect(quotaAccountSections('opencode', snapshot(), [], null).map((section) => section.id)).toEqual(['legacy']);
    expect(quotaAccountSections('opencode', snapshot(), [], []).map((section) => section.id)).toEqual(['legacy']);
  });
});
