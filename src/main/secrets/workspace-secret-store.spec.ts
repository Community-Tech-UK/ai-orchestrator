import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture what the real logger is handed. Spying on `console` is NOT enough — the
// project logger does not route through console under test, so a console spy passes
// even when the value is deliberately leaked into a log call (verified by mutation).
const { logCalls } = vi.hoisted(() => ({ logCalls: [] as unknown[] }));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: (message: string, data?: unknown) => { logCalls.push(message, data); },
    warn: (message: string, data?: unknown) => { logCalls.push(message, data); },
    error: (message: string, data?: unknown) => { logCalls.push(message, data); },
    debug: (message: string, data?: unknown) => { logCalls.push(message, data); },
  }),
}));

import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { SafeStorageAccessor } from '../session/safe-storage-accessor';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { NO_WORKSPACE_KEY } from './secret-workspace-key';
import {
  SafeStorageUnavailableError,
  WorkspaceSecretStore,
  normaliseName,
} from './workspace-secret-store';

const WS_A = '/ws/a';
const WS_B = '/ws/b';
const TOKEN = 'ghp_exampleplaceholdervalue0000000000';

const dbs: SqliteDriver[] = [];

/**
 * A real in-memory SQLite database, not a hand-written fake. A fake that answers
 * from its own memory would happily keep passing if the SQL were deleted.
 */
function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

/** Reversible stand-in for the OS keychain, so tests assert storage, not crypto. */
function fakeSafeStorage(available = true): SafeStorageAccessor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''),
  };
}

function makeStore(overrides: {
  db?: SqliteDriver;
  safeStorage?: SafeStorageAccessor;
} = {}): WorkspaceSecretStore {
  let counter = 0;
  return new WorkspaceSecretStore({
    db: overrides.db ?? openDb(),
    safeStorage: overrides.safeStorage ?? fakeSafeStorage(),
    now: () => 1_000,
    newId: () => `id-${++counter}`,
  });
}

beforeEach(() => {
  logCalls.length = 0;
});

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('WorkspaceSecretStore.put', () => {
  it('stores a secret and returns metadata that contains no value', () => {
    const store = makeStore();
    const meta = store.put({ workspaceId: WS_A, name: 'github-pat', label: 'GitHub PAT', purpose: 'watch deploys', value: TOKEN });

    expect(meta.name).toBe('github-pat');
    expect(meta.workspaceId).toBe(WS_A);
    expect(JSON.stringify(meta)).not.toContain(TOKEN);
  });

  it('persists ciphertext, never the plaintext', () => {
    const db = openDb();
    const store = makeStore({ db });
    store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });

    const row = db.prepare('SELECT value_enc FROM workspace_secrets').get<{ value_enc: string }>();
    expect(row?.value_enc).toBeTruthy();
    expect(row?.value_enc).not.toContain(TOKEN);
  });

  it('fails closed when the OS cannot encrypt, and writes nothing', () => {
    const db = openDb();
    const store = makeStore({ db, safeStorage: fakeSafeStorage(false) });

    expect(() => store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN }))
      .toThrow(SafeStorageUnavailableError);

    const count = db.prepare('SELECT COUNT(*) AS n FROM workspace_secrets').get<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('refuses the unscoped workspace, so scratch instances cannot share a pool', () => {
    const store = makeStore();
    expect(() => store.put({ workspaceId: NO_WORKSPACE_KEY, name: 'github-pat', value: TOKEN }))
      .toThrow(/unscoped workspace is refused/);
    expect(() => store.put({ workspaceId: '', name: 'github-pat', value: TOKEN }))
      .toThrow(/unscoped workspace is refused/);
  });

  it('replaces an existing secret in place rather than duplicating it', () => {
    const db = openDb();
    const store = makeStore({ db });
    const first = store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });
    const second = store.put({ workspaceId: WS_A, name: 'github-pat', value: `${TOKEN}-rotated` });

    expect(second.id).toBe(first.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM workspace_secrets').get<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('keeps the same name in two workspaces separate', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });
    store.put({ workspaceId: WS_B, name: 'github-pat', value: `${TOKEN}-other` });

    expect(store.list(WS_A)).toHaveLength(1);
    expect(store.list(WS_B)).toHaveLength(1);
    expect(store.has(WS_A, 'github-pat')).toBe(true);
    expect(store.has(WS_B, 'github-pat')).toBe(true);
  });

  it('never writes the value into a log line', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });

    // The store must have logged *something*, or this assertion is vacuous.
    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toContain(TOKEN);
  });

  it('never writes the value into a log line on the fail-closed path either', () => {
    const store = makeStore({ safeStorage: fakeSafeStorage(false) });
    expect(() => store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN }))
      .toThrow(SafeStorageUnavailableError);

    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toContain(TOKEN);
  });

  it('never puts the value into a thrown error', () => {
    const store = makeStore({ safeStorage: fakeSafeStorage(false) });
    try {
      store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });
      expect.unreachable('put should have thrown');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(TOKEN);
      expect(String((error as Error).stack ?? '')).not.toContain(TOKEN);
    }
  });
});

describe('WorkspaceSecretStore.list', () => {
  it('exposes no value field at all', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });

    const [meta] = store.list(WS_A);
    expect(Object.keys(meta)).not.toContain('value');
    expect(Object.keys(meta)).not.toContain('valueEnc');
    expect(JSON.stringify(meta)).not.toContain(TOKEN);
  });

  it('scopes to the requested workspace', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'a-secret', value: TOKEN });
    expect(store.list(WS_B)).toEqual([]);
  });
});

describe('WorkspaceSecretStore.forget', () => {
  it('removes the row and reports whether anything was removed', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });

    expect(store.forget(WS_A, 'github-pat')).toBe(true);
    expect(store.has(WS_A, 'github-pat')).toBe(false);
    expect(store.forget(WS_A, 'github-pat')).toBe(false);
  });

  it('will not delete another workspace\'s secret', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });

    expect(store.forget(WS_B, 'github-pat')).toBe(false);
    expect(store.has(WS_A, 'github-pat')).toBe(true);
  });
});

describe('audit trail', () => {
  it('records created, updated, forgotten and declined without any value', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', purpose: 'watch deploys', value: TOKEN });
    store.put({ workspaceId: WS_A, name: 'github-pat', purpose: 'watch deploys', value: `${TOKEN}2` });
    store.recordDeclined(WS_A, 'other-secret');
    store.forget(WS_A, 'github-pat');

    const events = store.auditTrail(WS_A).map((e) => e.event).sort();
    expect(events).toEqual(['created', 'declined', 'forgotten', 'updated']);
    expect(JSON.stringify(store.auditTrail(WS_A))).not.toContain(TOKEN);
  });
});

describe('WorkspaceSecretStore.resolve', () => {
  it('returns plaintext to the caller and never logs or throws it', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', purpose: 'watch deploys', value: TOKEN });
    logCalls.length = 0;

    const value = store.resolve('secret://github-pat', { workspaceId: WS_A, purpose: 'browser.fill_secret' });
    expect(value).toBe(TOKEN);
    expect(JSON.stringify(logCalls)).not.toContain(TOKEN);
    expect(store.auditTrail(WS_A).some((e) => e.event === 'resolved')).toBe(true);
    expect(JSON.stringify(store.auditTrail(WS_A))).not.toContain(TOKEN);
  });

  it('refuses a cross-workspace resolve', () => {
    const store = makeStore();
    store.put({ workspaceId: WS_A, name: 'github-pat', value: TOKEN });
    expect(() => store.resolve('secret://github-pat', { workspaceId: WS_B }))
      .toThrow(/does not exist/);
  });

  it('refuses the unscoped workspace', () => {
    const store = makeStore();
    expect(() => store.resolve('secret://github-pat', { workspaceId: NO_WORKSPACE_KEY }))
      .toThrow(/unscoped workspace is refused/);
  });

  it('does not put the value into a thrown error when missing', () => {
    const store = makeStore();
    try {
      store.resolve('secret://missing', { workspaceId: WS_A });
      expect.unreachable('resolve should have thrown');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(TOKEN);
    }
  });
});

describe('normaliseName', () => {
  it('slugs equivalent names together', () => {
    expect(normaliseName('GitHub PAT')).toBe('github-pat');
    expect(normaliseName('  github_pat  ')).toBe('github-pat');
    expect(normaliseName('github-pat')).toBe('github-pat');
  });

  it('rejects a name with no usable characters', () => {
    expect(() => normaliseName('   ')).toThrow(/name is required/);
    expect(() => normaliseName('!!!')).toThrow(/name is required/);
  });
});
