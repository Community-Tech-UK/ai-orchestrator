import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { McpSecretStorage } from '../mcp/secret-storage';
import { GraphTokenStore } from './graph-token-store';

const dbs: SqliteDriver[] = [];

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  return db;
}

function encryptedStorage(): McpSecretStorage {
  return new McpSecretStorage({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`wrapped:${plain}`, 'utf8'),
      decryptString: (encrypted) =>
        encrypted.toString('utf8').replace(/^wrapped:/, ''),
    },
  });
}

describe('GraphTokenStore', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
  });

  it('round-trips an account cache without storing the serialized cache in plaintext', () => {
    const db = openDb();
    const store = new GraphTokenStore(db, encryptedStorage(), () => 1_234);

    store.upsertAccount({
      accountKey: 'account-key',
      username: 'user@example.test',
      tenant: 'tenant-id',
      tokenCache: 'serialized-msal-cache',
    });

    expect(store.getTokenCache('account-key')).toBe('serialized-msal-cache');
    expect(store.getAccount('account-key')).toEqual({
      accountKey: 'account-key',
      username: 'user@example.test',
      tenant: 'tenant-id',
      createdAt: 1_234,
      updatedAt: 1_234,
    });

    const row = db
      .prepare(
        'SELECT token_cache_encrypted_json FROM graph_accounts WHERE account_key = ?',
      )
      .get<{ token_cache_encrypted_json: string }>('account-key');
    expect(row?.token_cache_encrypted_json).not.toContain('serialized-msal-cache');
  });

  it('lists account metadata without exposing token caches', () => {
    const store = new GraphTokenStore(openDb(), encryptedStorage(), () => 1_234);
    store.upsertAccount({
      accountKey: 'second-account',
      username: 'zeta@example.test',
      tenant: 'second-tenant',
      tokenCache: 'second-serialized-cache',
    });
    store.upsertAccount({
      accountKey: 'first-account',
      username: 'alpha@example.test',
      tenant: 'first-tenant',
      tokenCache: 'first-serialized-cache',
    });

    expect(store.listAccounts()).toEqual([
      {
        accountKey: 'first-account',
        username: 'alpha@example.test',
        tenant: 'first-tenant',
        createdAt: 1_234,
        updatedAt: 1_234,
      },
      {
        accountKey: 'second-account',
        username: 'zeta@example.test',
        tenant: 'second-tenant',
        createdAt: 1_234,
        updatedAt: 1_234,
      },
    ]);
  });

  it('removes the account metadata and encrypted cache together', () => {
    const store = new GraphTokenStore(openDb(), encryptedStorage());
    store.upsertAccount({
      accountKey: 'account-key',
      username: 'user@example.test',
      tenant: 'tenant-id',
      tokenCache: 'serialized-msal-cache',
    });

    expect(store.removeAccount('account-key')).toBe(true);
    expect(store.getAccount('account-key')).toBeNull();
    expect(store.getTokenCache('account-key')).toBeNull();
    expect(store.removeAccount('account-key')).toBe(false);
  });

  it('updates and re-encrypts the cache for an existing account only', () => {
    let now = 100;
    const db = openDb();
    const store = new GraphTokenStore(db, encryptedStorage(), () => now);
    store.upsertAccount({
      accountKey: 'account-key',
      username: 'user@example.test',
      tenant: 'tenant-id',
      tokenCache: 'initial-serialized-cache',
    });

    now = 200;
    expect(store.updateTokenCache('account-key', 'refreshed-serialized-cache')).toBe(
      true,
    );
    expect(store.getTokenCache('account-key')).toBe('refreshed-serialized-cache');
    expect(store.getAccount('account-key')?.updatedAt).toBe(200);
    expect(store.updateTokenCache('missing-account', 'orphan-cache')).toBe(false);
    expect(store.getAccount('missing-account')).toBeNull();

    const raw = db
      .prepare(
        'SELECT token_cache_encrypted_json FROM graph_accounts WHERE account_key = ?',
      )
      .get<{ token_cache_encrypted_json: string }>('account-key');
    expect(raw?.token_cache_encrypted_json).not.toContain(
      'refreshed-serialized-cache',
    );
  });

  it('refuses to persist a cache when safeStorage encryption is unavailable', () => {
    const db = openDb();
    const store = new GraphTokenStore(
      db,
      new McpSecretStorage({
        safeStorage: { isEncryptionAvailable: () => false },
      }),
    );

    expect(() =>
      store.upsertAccount({
        accountKey: 'account-key',
        username: 'user@example.test',
        tenant: 'tenant-id',
        tokenCache: 'serialized-msal-cache',
      }),
    ).toThrow('SAFESTORAGE_UNAVAILABLE');
    expect(
      db.prepare('SELECT account_key FROM graph_accounts').all(),
    ).toEqual([]);
  });

  it('refuses to read a plaintext-quarantined cache record', () => {
    const db = openDb();
    const store = new GraphTokenStore(db, encryptedStorage());
    db.prepare(`
      INSERT INTO graph_accounts (
        account_key, username, tenant, token_cache_encrypted_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'account-key',
      'user@example.test',
      'tenant-id',
      JSON.stringify({
        status: 'plaintext-quarantined',
        payload: 'plaintext-cache-placeholder',
      }),
      100,
      100,
    );

    expect(() => store.getTokenCache('account-key')).toThrow(
      'GRAPH_TOKEN_CACHE_INVALID',
    );
  });
});
