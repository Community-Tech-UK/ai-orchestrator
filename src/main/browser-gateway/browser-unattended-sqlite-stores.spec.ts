import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import {
  SqliteVaultOriginBindingStore,
  SqliteCredentialAuthorizationStore,
  SqliteEscalationRecordStore,
  SqliteBrowserCampaignStore,
  SqliteLoginRecipeStore,
} from './browser-unattended-sqlite-stores';
import { LoginFingerprintStore } from './browser-login-recipe-store';

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

  it('keeps a login recipe across a restart and finds it from a new tab on the same node', () => {
    const origin = 'https://supplier.example.co.uk';
    new LoginFingerprintStore(new SqliteLoginRecipeStore(db), () => 100).remember({
      profileId: 'existing-tab:n.node-1:5:6',
      origin: `${origin}/some/page`,
      loginUrl: `${origin}/home`,
      loggedInMarkers: ['Logout'],
      relogin: {
        vaultItemRef: 'vault-item-1',
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: '#login',
      },
    });

    // A fresh service over the same database is what the app sees after a
    // restart. Nothing process-local survives.
    const afterRestart = new LoginFingerprintStore(new SqliteLoginRecipeStore(db), () => 200);
    const recipe = afterRestart.find('existing-tab:n.node-1:9:77', origin);
    expect(recipe).toEqual({
      scope: 'node-1',
      scopeKind: 'node',
      origin,
      loginUrl: `${origin}/home`,
      loggedInMarkers: ['Logout'],
      relogin: {
        vaultItemRef: 'vault-item-1',
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: '#login',
      },
      createdAt: 100,
      updatedAt: 100,
    });
    expect(afterRestart.find('existing-tab:n.node-2:9:77', origin)).toBeUndefined();
    expect(afterRestart.find('existing-tab:n.node-1:9:77', 'https://other.example')).toBeUndefined();
  });

  it('keeps the relogin recipe on a markers-only refresh and records outcomes', () => {
    const origin = 'https://portal.example.gov.uk';
    const store = new LoginFingerprintStore(new SqliteLoginRecipeStore(db), () => 10);
    store.remember({
      profileId: 'managed-1',
      origin,
      loginUrl: `${origin}/login`,
      loggedInMarkers: ['Sign out'],
      relogin: { vaultItemRef: 'item', passwordSelector: '#pw' },
    });
    store.remember({ profileId: 'managed-1', origin, loginUrl: `${origin}/login`, loggedInMarkers: ['Account'] });
    store.recordOutcome('managed-1', origin, 'relogin_failed', 'relogin submit refused: grant_required');

    expect(store.list({ profileId: 'managed-1' })).toEqual([
      expect.objectContaining({
        scope: 'managed-1',
        scopeKind: 'profile',
        loggedInMarkers: ['Account'],
        relogin: { vaultItemRef: 'item', passwordSelector: '#pw' },
        lastOutcome: 'relogin_failed',
        lastOutcomeReason: 'relogin submit refused: grant_required',
        lastOutcomeAt: 10,
      }),
    ]);
    // An outcome for a scope with no row writes nothing.
    store.recordOutcome('managed-2', origin, 'logged_in', 'fingerprint_matched');
    expect(store.list()).toHaveLength(1);

    expect(store.forget('managed-1', `${origin}/`)).toBe(true);
    expect(store.forget('managed-1', origin)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('persists only reference and selector fields of a relogin recipe', () => {
    const records = new SqliteLoginRecipeStore(db);
    records.put({
      scope: 'local',
      scopeKind: 'node',
      origin: 'https://a.example',
      loginUrl: 'https://a.example/login',
      loggedInMarkers: ['Log out'],
      relogin: {
        vaultItemRef: 'item',
        passwordSelector: '#pw',
        // A stray property must never reach the table.
        ...({ password: 'TEST_ONLY_NOT_A_SECRET' } as object),
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const raw = db
      .prepare(`SELECT relogin_json FROM browser_login_recipes WHERE scope = 'local'`)
      .get<{ relogin_json: string }>();
    expect(JSON.parse(raw!.relogin_json)).toEqual({ vaultItemRef: 'item', passwordSelector: '#pw' });
  });

  it('rejects a non-http origin or login URL', () => {
    const store = new LoginFingerprintStore(new SqliteLoginRecipeStore(db));
    expect(() => store.remember({
      profileId: 'p', origin: 'javascript:alert(1)', loginUrl: 'https://a.example', loggedInMarkers: ['x'],
    })).toThrow(/origin/);
    expect(() => store.remember({
      profileId: 'p', origin: 'https://a.example', loginUrl: 'file:///etc/passwd', loggedInMarkers: ['x'],
    })).toThrow(/loginUrl/);
  });
});
