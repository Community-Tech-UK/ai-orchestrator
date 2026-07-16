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
});
