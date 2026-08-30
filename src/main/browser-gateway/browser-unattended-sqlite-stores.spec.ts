import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import {
  SqliteVaultOriginBindingStore,
  SqliteCredentialAuthorizationStore,
  SqliteEscalationRecordStore,
  SqliteBrowserCampaignStore,
} from './browser-unattended-sqlite-stores';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('unattended SQLite stores (migration 040)', () => {
  let db: SqliteDriver;
  beforeEach(() => {
    db = createDb();
  });
  afterEach(() => db.close());

  it('round-trips a vault origin binding', () => {
    const store = new SqliteVaultOriginBindingStore(db);
    store.put({ vaultItemRef: 'item-1', origin: 'https://a.example', username: 'u', createdAt: 5 });
    expect(store.get('item-1')).toEqual({
      vaultItemRef: 'item-1',
      origin: 'https://a.example',
      username: 'u',
      createdAt: 5,
    });
    // Upsert on conflict.
    store.put({ vaultItemRef: 'item-1', origin: 'https://b.example', username: 'u2', createdAt: 6 });
    expect(store.get('item-1')?.origin).toBe('https://b.example');
    expect(store.get('missing')).toBeUndefined();
  });

  it('round-trips a credential authorization and honours the revoked filter', () => {
    const store = new SqliteCredentialAuthorizationStore(db);
    store.insert({
      id: 'auth-1',
      profileId: 'profile-1',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'a.example', includeSubdomains: false }],
      purposes: ['login', 'register'],
      vaultFolder: 'AIO-Agent',
      createdAt: 1,
      expiresAt: 1_000,
    });

    const loaded = store.get('auth-1');
    expect(loaded).toMatchObject({ profileId: 'profile-1', purposes: ['login', 'register'] });
    expect(loaded?.allowedOrigins[0]).toMatchObject({ hostPattern: 'a.example' });

    expect(store.list({ profileId: 'profile-1' })).toHaveLength(1);
    store.markRevoked('auth-1', 500);
    expect(store.list({ profileId: 'profile-1' })).toHaveLength(0);
    expect(store.list({ profileId: 'profile-1', includeRevoked: true })).toHaveLength(1);
    expect(store.get('auth-1')?.revokedAt).toBe(500);
  });

  it('replace() upserts every column, and inserts when nothing is there', () => {
    // This is the only production implementation of `replace`. Everything else
    // in the change exercises an in-memory double, and the whole reason the
    // upsert exists is that the double behaves differently from this store.
    const store = new SqliteCredentialAuthorizationStore(db);
    const base = {
      id: 'auth-r',
      profileId: 'profile-1',
      allowedOrigins: [{ scheme: 'https' as const, hostPattern: 'a.example', includeSubdomains: false }],
      purposes: ['login' as const],
      vaultFolder: 'AIO-Agent',
      createdAt: 1,
      expiresAt: 1_000,
    };

    // Insert path: no prior row.
    store.replace(base);
    expect(store.get('auth-r')).toMatchObject({ profileId: 'profile-1', expiresAt: 1_000 });

    // Update path: every mutable column must actually change.
    store.replace({
      ...base,
      profileId: 'profile-2',
      allowedOrigins: [{ scheme: 'http', hostPattern: 'b.example', includeSubdomains: true }],
      purposes: ['login', 'totp'],
      vaultFolder: 'Other',
      createdAt: 2,
      expiresAt: 5_000,
      note: 'renewed',
      allowedSenderDomains: ['notifications.service.gov.uk'],
    });

    const loaded = store.get('auth-r');
    expect(loaded).toMatchObject({
      profileId: 'profile-2',
      purposes: ['login', 'totp'],
      vaultFolder: 'Other',
      createdAt: 2,
      expiresAt: 5_000,
      note: 'renewed',
      allowedSenderDomains: ['notifications.service.gov.uk'],
    });
    expect(loaded?.allowedOrigins[0]).toMatchObject({
      scheme: 'http', hostPattern: 'b.example', includeSubdomains: true,
    });
    // Still one row, not two.
    expect(store.list({ profileId: 'profile-2', includeRevoked: true })).toHaveLength(1);
  });

  it('replace() clears revoked_at, which is why callers must check first', () => {
    // The upsert writes revoked_at from the incoming record, so replacing a
    // revoked row resurrects it. browser-autonomy-config.ts refuses to call
    // recreate on a revoked grant for exactly this reason; this pins the
    // underlying behaviour so that guard is never assumed away.
    const store = new SqliteCredentialAuthorizationStore(db);
    const base = {
      id: 'auth-v',
      profileId: 'profile-1',
      allowedOrigins: [{ scheme: 'https' as const, hostPattern: 'a.example', includeSubdomains: false }],
      purposes: ['login' as const],
      vaultFolder: 'AIO-Agent',
      createdAt: 1,
      expiresAt: 1_000,
    };
    store.insert(base);
    store.markRevoked('auth-v', 500);
    expect(store.get('auth-v')?.revokedAt).toBe(500);

    store.replace({ ...base, expiresAt: 9_000 });

    expect(store.get('auth-v')?.revokedAt).toBeUndefined();
    expect(store.list({ profileId: 'profile-1' }).map((a) => a.id)).toContain('auth-v');
  });

  it('persists the optional scope fields, which used to be dropped on reload', () => {
    const store = new SqliteCredentialAuthorizationStore(db);
    store.insert({
      id: 'auth-scoped',
      profileId: 'windows-pc',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'gca.gov.uk', includeSubdomains: true }],
      purposes: ['login', 'email_code'],
      vaultFolder: 'AIO-Agent',
      createdAt: 1,
      expiresAt: 1_000,
      allowedSelectors: ['#password'],
      allowedSecretTypes: ['iban'],
      allowedSenderDomains: ['notifications.service.gov.uk'],
    });

    const loaded = store.get('auth-scoped');
    // Losing allowedSelectors would silently WIDEN the authorization.
    expect(loaded?.allowedSelectors).toEqual(['#password']);
    expect(loaded?.allowedSecretTypes).toEqual(['iban']);
    expect(loaded?.allowedSenderDomains).toEqual(['notifications.service.gov.uk']);
  });

  it('omits scope fields that are absent or malformed rather than guessing', () => {
    const store = new SqliteCredentialAuthorizationStore(db);
    store.insert({
      id: 'auth-plain',
      profileId: 'profile-1',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'a.example', includeSubdomains: false }],
      purposes: ['login'],
      vaultFolder: 'AIO-Agent',
      createdAt: 1,
      expiresAt: 1_000,
    });
    const plain = store.get('auth-plain');
    expect(plain).not.toHaveProperty('allowedSelectors');
    expect(plain).not.toHaveProperty('allowedSenderDomains');

    db.prepare(
      `UPDATE browser_credential_authorizations
         SET allowed_selectors_json = ?, allowed_secret_types_json = ?
       WHERE id = ?`,
    ).run('not json', '["iban","nonsense_kind"]', 'auth-plain');
    const reloaded = store.get('auth-plain');
    expect(reloaded).not.toHaveProperty('allowedSelectors');
    // Unknown secret kinds are dropped; the grant can only narrow, never widen.
    expect(reloaded?.allowedSecretTypes).toEqual(['iban']);
  });

  it('round-trips an escalation and updates status', () => {
    const store = new SqliteEscalationRecordStore(db);
    store.insert({
      id: 'esc-1',
      campaignId: 'camp-1',
      profileId: 'profile-1',
      kind: 'captcha',
      reason: 'captcha on signup',
      status: 'pending',
      createdAt: 10,
    });
    expect(store.list({ status: 'pending' })).toHaveLength(1);
    expect(store.list({ campaignId: 'camp-1' })).toHaveLength(1);

    store.update({
      id: 'esc-1',
      campaignId: 'camp-1',
      profileId: 'profile-1',
      kind: 'captcha',
      reason: 'captcha on signup',
      status: 'resolved',
      createdAt: 10,
      resolvedAt: 20,
      resolutionNote: 'done by hand',
    });
    expect(store.get('esc-1')).toMatchObject({ status: 'resolved', resolvedAt: 20, resolutionNote: 'done by hand' });
    expect(store.list({ status: 'pending' })).toHaveLength(0);
  });

  it('round-trips a campaign and its counters', () => {
    const store = new SqliteBrowserCampaignStore(db);
    store.put({
      id: 'camp-1',
      label: 'Overnight procurement signups',
      profileId: 'profile-1',
      allowedOrigins: ['https://portal.example.gov.uk'],
      allowedActionClasses: ['input', 'submit'],
      budget: { maxActions: 100, maxSubmits: 5, maxNewAccounts: 3, maxUploads: 10, maxDurationMs: 3_600_000 },
      approvedDeclarationHashes: ['abc123'],
      status: 'active',
      createdAt: 1,
      expiresAt: 3_600_001,
      approvedBy: 'user',
    });

    const loaded = store.get('camp-1');
    expect(loaded).toMatchObject({ status: 'active', allowedActionClasses: ['input', 'submit'] });
    expect(loaded?.budget.maxSubmits).toBe(5);
    expect(loaded?.approvedDeclarationHashes).toEqual(['abc123']);

    expect(store.getCounters('camp-1')).toBeUndefined();
    store.putCounters('camp-1', { actions: 3, submits: 1, newAccounts: 1, uploads: 0 });
    expect(store.getCounters('camp-1')).toEqual({ actions: 3, submits: 1, newAccounts: 1, uploads: 0 });
    // Upsert.
    store.putCounters('camp-1', { actions: 4, submits: 1, newAccounts: 1, uploads: 0 });
    expect(store.getCounters('camp-1')?.actions).toBe(4);

    // Status update via put (upsert).
    store.put({ ...loaded!, status: 'paused' });
    expect(store.get('camp-1')?.status).toBe('paused');
    expect(store.list()).toHaveLength(1);
  });
});
