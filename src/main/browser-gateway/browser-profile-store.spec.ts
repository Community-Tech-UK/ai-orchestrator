import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { BrowserProfileStore } from './browser-profile-store';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('BrowserProfileStore', () => {
  let db: SqliteDriver;
  let store: BrowserProfileStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = createDb();
    store = new BrowserProfileStore(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('applies the browser gateway migration', () => {
    const migration = db
      .prepare(`SELECT name FROM _migrations WHERE name = ?`)
      .get<{ name: string }>('023_browser_gateway');
    const profileColumns = db
      .prepare(`PRAGMA table_info(browser_profiles)`)
      .all<{ name: string }>();

    expect(migration?.name).toBe('023_browser_gateway');
    expect(profileColumns.map((column) => column.name)).toContain('allowed_origins_json');
  });

  it('creates, lists, gets, updates, and deletes profiles', () => {
    const created = store.createProfile({
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: true,
        },
      ],
      defaultUrl: 'https://play.google.com/console',
    });

    expect(created).toMatchObject({
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      defaultUrl: 'https://play.google.com/console',
      status: 'stopped',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(created.id).toBeTruthy();
    expect(store.listProfiles()).toEqual([created]);
    expect(store.getProfile(created.id)).toEqual(created);

    vi.setSystemTime(2_000);
    const updated = store.updateProfile(created.id, {
      label: 'Local Test',
      defaultUrl: null,
      allowedOrigins: [
        {
          scheme: 'http',
          hostPattern: 'localhost',
          port: 4567,
          includeSubdomains: false,
        },
      ],
    });

    expect(updated.label).toBe('Local Test');
    expect(updated.defaultUrl).toBeUndefined();
    expect(updated.allowedOrigins[0]?.hostPattern).toBe('localhost');
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(2_000);

    store.deleteProfile(created.id);
    expect(store.getProfile(created.id)).toBeNull();
    expect(store.listProfiles()).toEqual([]);
  });

  it('updates only runtime state fields', () => {
    const created = store.createProfile({
      label: 'Runtime',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [],
    });

    vi.setSystemTime(3_000);
    const updated = store.setRuntimeState(created.id, {
      status: 'running',
      debugPort: 9222,
      debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      processId: 12345,
      lastLaunchedAt: 3_000,
      lastUsedAt: 3_100,
      lastLoginCheckAt: 3_200,
    });

    expect(updated).toMatchObject({
      id: created.id,
      label: 'Runtime',
      status: 'running',
      debugPort: 9222,
      debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      processId: 12345,
      lastLaunchedAt: 3_000,
      lastUsedAt: 3_100,
      lastLoginCheckAt: 3_200,
      updatedAt: 3_000,
    });
  });

  it('returns an empty allowlist when stored JSON is invalid', () => {
    const created = store.createProfile({
      label: 'Corrupt',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    });

    db.prepare(`UPDATE browser_profiles SET allowed_origins_json = ? WHERE id = ?`).run(
      'not-json',
      created.id,
    );

    expect(store.getProfile(created.id)?.allowedOrigins).toEqual([]);
  });

  it('returns an empty allowlist when stored JSON has an invalid origin shape', () => {
    const created = store.createProfile({
      label: 'Invalid Shape',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [],
    });

    db.prepare(`UPDATE browser_profiles SET allowed_origins_json = ? WHERE id = ?`).run(
      JSON.stringify([
        {
          scheme: 'ftp',
          hostPattern: '',
          includeSubdomains: 'no',
        },
      ]),
      created.id,
    );

    expect(store.getProfile(created.id)?.allowedOrigins).toEqual([]);
  });
});
