import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ProviderLimitLedger, createProviderLimitLedgerSchema } from '../../core/system/provider-limit-ledger';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { isProviderParkedForFailover } from './provider-parked-veto';

function profile(id: string, enabled = true): ProviderAccountProfile {
  return {
    id, provider: 'claude', label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority: id === 'legacy' ? 0 : 1, enabled, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  };
}

describe('isProviderParkedForFailover', () => {
  const now = 1_700_000_000_000;
  function setup(profiles: ProviderAccountProfile[], cached: Record<string, string> = {}) {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    createProviderLimitLedgerSchema(db);
    const ledger = new ProviderLimitLedger(db);
    const deps = {
      ledger,
      store: { listProfiles: () => profiles },
      bindings: { getCached: (_p: string, id: string) => (cached[id] ? { state: cached[id] } : null) } as never,
      now,
    };
    const park = (accountProfileId: string | null) => ledger.record({
      provider: 'claude', model: null, accountProfileId, detectedAt: now, resumeAt: now + 60_000, source: 'test', instanceId: null,
    });
    return { deps, park, db };
  }

  it('parks a pooled provider only when every eligible profile is parked', () => {
    const { deps, park, db } = setup([profile('legacy'), profile('max-b')]);
    park('legacy');
    expect(isProviderParkedForFailover('claude', null, deps)).toBe(false);
    park('max-b');
    expect(isProviderParkedForFailover('claude', null, deps)).toBe(true);
    db.close();
  });

  it('ignores disabled and signed-out profiles when deciding', () => {
    const { deps, park, db } = setup([profile('legacy'), profile('max-b', false), profile('max-c')], { 'max-c': 'unauthenticated' });
    park('legacy');
    expect(isProviderParkedForFailover('claude', null, deps)).toBe(true);
    db.close();
  });

  it('keeps the old single-row check for non-pooled providers', () => {
    const { deps, db } = setup([]);
    deps.ledger.record({ provider: 'copilot', model: null, detectedAt: now, resumeAt: now + 1, source: 't', instanceId: null });
    expect(isProviderParkedForFailover('copilot', null, deps)).toBe(true);
    expect(isProviderParkedForFailover('cursor', null, deps)).toBe(false);
    db.close();
  });
});
