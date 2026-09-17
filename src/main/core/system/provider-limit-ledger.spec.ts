import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  ProviderLimitLedger,
  createProviderLimitLedgerSchema,
} from './provider-limit-ledger';

describe('ProviderLimitLedger', () => {
  let db: SqliteDriver;
  let ledger: ProviderLimitLedger;

  beforeEach(() => {
    db = new Database(':memory:') as unknown as SqliteDriver;
    createProviderLimitLedgerSchema(db);
    ledger = new ProviderLimitLedger(db);
  });

  afterEach(() => {
    db.close();
  });

  it('prefers an active exact model limit over an account-wide fallback', () => {
    const now = 1_700_000_000_000;
    ledger.record({
      provider: 'claude',
      model: null,
      detectedAt: now - 100,
      resumeAt: now + 20_000,
      source: 'adapter-error',
      instanceId: 'account-limit',
    });
    ledger.record({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      detectedAt: now,
      resumeAt: now + 10_000,
      source: 'adapter-error',
      instanceId: 'model-limit',
    });

    expect(ledger.getActive({ provider: 'claude', model: 'claude-sonnet-4-5', now })).toMatchObject({
      instanceId: 'model-limit',
      model: 'claude-sonnet-4-5',
      resumeAt: now + 10_000,
    });
  });

  it('uses an active account-wide limit when the requested model has no exact limit', () => {
    const now = 1_700_000_000_000;
    ledger.record({
      provider: 'codex',
      model: null,
      detectedAt: now,
      resumeAt: now + 10_000,
      source: 'quota-snapshot',
      instanceId: 'instance-1',
    });

    expect(ledger.getActive({ provider: 'codex', model: 'gpt-5.4', now })).toMatchObject({
      model: null,
      instanceId: 'instance-1',
    });
  });

  it('never returns an expired event and removes it during expiry cleanup', () => {
    const now = 1_700_000_000_000;
    ledger.record({
      provider: 'gemini',
      model: null,
      detectedAt: now - 20_000,
      resumeAt: now - 1,
      source: 'provider-notice',
      instanceId: 'expired',
    });

    expect(ledger.getActive({ provider: 'gemini', model: null, now })).toBeNull();
    expect(ledger.deleteExpired(now)).toBe(1);
    expect(ledger.list({ provider: 'gemini' })).toEqual([]);
  });

  it('clearActive drops still-active gates for the model and account fallback (user override)', () => {
    const now = 1_700_000_000_000;
    const resumeAt = now + 10_000;
    ledger.record({ provider: 'codex', model: null, detectedAt: now, resumeAt, source: 'adapter-error', instanceId: 'account' });
    ledger.record({ provider: 'codex', model: 'gpt-5.6', detectedAt: now, resumeAt, source: 'adapter-error', instanceId: 'model' });
    ledger.record({ provider: 'codex', model: 'gpt-5.4', detectedAt: now, resumeAt, source: 'adapter-error', instanceId: 'other-model' });
    ledger.record({ provider: 'claude', model: null, detectedAt: now, resumeAt, source: 'adapter-error', instanceId: 'other-provider' });

    expect(ledger.clearActive({ provider: 'codex', model: 'gpt-5.6', now })).toBe(2);
    expect(ledger.list({ provider: 'codex' }).map((event) => event.instanceId)).toEqual(['other-model']);
    expect(ledger.list({ provider: 'claude' })).toHaveLength(1);
    expect(ledger.getActive({ provider: 'codex', model: 'gpt-5.6', now })).toBeNull();
  });

  it('clearActive with no model scope clears provider-wide (account evidence) but ignores expired rows and other providers', () => {
    const now = 1_700_000_000_000;
    ledger.record({ provider: 'codex', model: null, detectedAt: now, resumeAt: now + 10_000, source: 'adapter-error', instanceId: 'account' });
    ledger.record({ provider: 'codex', model: 'gpt-5.6', detectedAt: now, resumeAt: now + 10_000, source: 'adapter-error', instanceId: 'model' });
    ledger.record({ provider: 'codex', model: null, detectedAt: now - 20_000, resumeAt: now - 1, source: 'adapter-error', instanceId: 'expired' });
    ledger.record({ provider: 'claude', model: null, detectedAt: now, resumeAt: now + 10_000, source: 'adapter-error', instanceId: 'other-provider' });

    expect(ledger.clearActive({ provider: 'codex', model: null, now })).toBe(2);
    expect(ledger.list({ provider: 'codex' }).map((event) => event.instanceId)).toEqual(['expired']);
    expect(ledger.list({ provider: 'claude' })).toHaveLength(1);
  });

  it('clears both the successful model scope and its account fallback only after their reset', () => {
    const now = 1_700_000_000_000;
    const resumeAt = now + 10_000;
    ledger.record({ provider: 'claude', model: null, detectedAt: now, resumeAt, source: 'adapter-error', instanceId: 'account' });
    ledger.record({ provider: 'claude', model: 'claude-opus-4-6', detectedAt: now, resumeAt, source: 'adapter-error', instanceId: 'model' });
    ledger.record({ provider: 'claude', model: 'claude-sonnet-4-5', detectedAt: now, resumeAt, source: 'adapter-error', instanceId: 'other-model' });

    expect(ledger.clearAfterSuccessfulTurn({ provider: 'claude', model: 'claude-opus-4-6', now })).toBe(0);
    expect(ledger.clearAfterSuccessfulTurn({ provider: 'claude', model: 'claude-opus-4-6', now: resumeAt })).toBe(2);
    expect(ledger.list({ provider: 'claude' }).map((event) => event.instanceId)).toEqual(['other-model']);
  });

  describe('account profile dimension', () => {
    const now = 1_700_000_000_000;
    const base = { provider: 'claude' as const, model: null, detectedAt: now, resumeAt: now + 60_000, source: 'test', instanceId: null };

    it('isolates limits per profile and treats omitted/legacy/null as the same legacy profile', () => {
      ledger.record({ ...base, accountProfileId: 'max-a' });
      expect(ledger.getActive({ provider: 'claude', model: null, accountProfileId: 'max-a', now })).toMatchObject({ accountProfileId: 'max-a' });
      expect(ledger.getActive({ provider: 'claude', model: null, accountProfileId: 'max-b', now })).toBeNull();
      expect(ledger.getActive({ provider: 'claude', model: null, now })).toBeNull();

      ledger.record({ ...base, accountProfileId: 'legacy' });
      expect(ledger.getActive({ provider: 'claude', model: null, now })).toMatchObject({ accountProfileId: null });
      expect(ledger.getActive({ provider: 'claude', model: null, accountProfileId: null, now })).not.toBeNull();
    });

    it('reports parked profiles and full-pool parking', () => {
      ledger.record({ ...base, accountProfileId: 'max-a' });
      ledger.record({ ...base });
      expect(ledger.getParkedProfileIds({ provider: 'claude', model: 'claude-opus', now }).sort()).toEqual(['legacy', 'max-a']);
      expect(ledger.isProviderFullyParked({ provider: 'claude', model: null, eligibleProfileIds: ['legacy', 'max-a'], now })).toBe(true);
      expect(ledger.isProviderFullyParked({ provider: 'claude', model: null, eligibleProfileIds: ['legacy', 'max-a', 'max-b'], now })).toBe(false);
      expect(ledger.isProviderFullyParked({ provider: 'claude', model: null, eligibleProfileIds: [], now })).toBe(true);
    });

    it('reports when each parked profile\'s newest active limit was recorded', () => {
      ledger.record({ ...base, accountProfileId: 'max-a', detectedAt: now - 500 });
      ledger.record({ ...base, accountProfileId: 'max-a', model: 'claude-opus', detectedAt: now - 100 });
      ledger.record({ ...base, detectedAt: now - 300 });
      // Expired and other-model rows do not hold this model's sends.
      ledger.record({ ...base, accountProfileId: 'max-b', detectedAt: now - 900, resumeAt: now - 1 });
      ledger.record({ ...base, accountProfileId: 'max-a', model: 'claude-sonnet', detectedAt: now - 50 });
      expect(ledger.getParkedSince({ provider: 'claude', model: 'claude-opus', now }))
        .toEqual(new Map([['max-a', now - 100], ['legacy', now - 300]]));
    });

    it('widens a null-model lookup to every model when asked, matching what clearActive removes', () => {
      ledger.record({ ...base, accountProfileId: 'max-a', detectedAt: now - 500 });
      ledger.record({ ...base, accountProfileId: 'max-a', model: 'claude-opus', detectedAt: now - 100 });
      expect(ledger.getParkedSince({ provider: 'claude', model: null, now }).get('max-a')).toBe(now - 500);
      expect(ledger.getParkedSince({ provider: 'claude', model: null, now, anyModel: true }).get('max-a')).toBe(now - 100);
      // anyModel does not widen a model-scoped lookup.
      ledger.record({ ...base, accountProfileId: 'max-a', model: 'claude-sonnet', detectedAt: now - 10 });
      expect(ledger.getParkedSince({ provider: 'claude', model: 'claude-opus', now, anyModel: true }).get('max-a')).toBe(now - 100);
    });

    it('returns the soonest reset across profiles', () => {
      ledger.record({ ...base, accountProfileId: 'max-a', resumeAt: now + 90_000 });
      ledger.record({ ...base, accountProfileId: 'max-b', resumeAt: now + 30_000 });
      expect(ledger.getSoonestResumeAt({ provider: 'claude', model: null, profileIds: ['max-a', 'max-b', 'max-c'], now })).toBe(now + 30_000);
    });

    it('clears only the named profile', () => {
      ledger.record({ ...base, accountProfileId: 'max-a' });
      ledger.record({ ...base });
      expect(ledger.clearActive({ provider: 'claude', model: null, accountProfileId: 'max-a', now })).toBe(1);
      expect(ledger.getActive({ provider: 'claude', model: null, now })).not.toBeNull();
    });

    it('upgrades a pre-pools table in place, keeping old rows readable as legacy', () => {
      const legacyDb = new Database(':memory:') as unknown as SqliteDriver;
      try {
        legacyDb.exec(`
          CREATE TABLE provider_limit_events (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
            detected_at INTEGER NOT NULL, resume_at INTEGER NOT NULL, source TEXT NOT NULL, instance_id TEXT
          );
          INSERT INTO provider_limit_events VALUES ('old', 'codex', '', ${now}, ${now + 60_000}, 'adapter-error', NULL);
        `);
        createProviderLimitLedgerSchema(legacyDb);
        const upgraded = new ProviderLimitLedger(legacyDb);
        expect(upgraded.getActive({ provider: 'codex', model: null, now })).toMatchObject({ id: 'old', accountProfileId: null });
        expect(upgraded.getActive({ provider: 'codex', model: null, accountProfileId: 'pro-b', now })).toBeNull();
      } finally {
        legacyDb.close();
      }
    });
  });
});
