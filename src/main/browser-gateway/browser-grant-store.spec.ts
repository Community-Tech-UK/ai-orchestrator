import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { BrowserGrantStore } from './browser-grant-store';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('BrowserGrantStore', () => {
  let db: SqliteDriver;
  let store: BrowserGrantStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = createDb();
    store = new BrowserGrantStore(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('applies the browser grants migration', () => {
    const migration = db
      .prepare(`SELECT name FROM _migrations WHERE name = ?`)
      .get<{ name: string }>('024_browser_gateway_grants_and_approvals');
    const grantColumns = db
      .prepare(`PRAGMA table_info(browser_permission_grants)`)
      .all<{ name: string }>();

    expect(migration?.name).toBe('024_browser_gateway_grants_and_approvals');
    expect(grantColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'mode',
        'allowed_origins_json',
        'allowed_action_classes_json',
        'autonomous',
        'consumed_at',
      ]),
    );
  });

  it('creates, lists, revokes, and consumes grants', () => {
    const grant = store.createGrant({
      mode: 'per_action',
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: true,
        },
      ],
      allowedActionClasses: ['input'],
      allowExternalNavigation: false,
      autonomous: false,
      requestedBy: 'user',
      decidedBy: 'user',
      decision: 'allow',
      expiresAt: 61_000,
    });

    expect(grant).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      allowedActionClasses: ['input'],
      autonomous: false,
      createdAt: 1_000,
    });
    expect(store.listGrants({ instanceId: 'instance-1' })).toEqual([grant]);

    vi.setSystemTime(2_000);
    const consumed = store.consumeGrant(grant.id);
    expect(consumed?.consumedAt).toBe(2_000);
    expect(store.listGrants({ instanceId: 'instance-1' })).toEqual([]);

    const sessionGrant = store.createGrant({
      mode: 'session',
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      allowedOrigins: grant.allowedOrigins,
      allowedActionClasses: ['input', 'submit'],
      allowExternalNavigation: true,
      autonomous: false,
      requestedBy: 'user',
      decidedBy: 'user',
      decision: 'allow',
      expiresAt: 20_000,
    });

    vi.setSystemTime(3_000);
    const revoked = store.revokeGrant(sessionGrant.id, 'manual revoke');
    expect(revoked?.revokedAt).toBe(3_000);
    expect(revoked?.reason).toBe('manual revoke');
    expect(store.listGrants({ includeExpired: true })).toHaveLength(2);
    expect(store.listGrants({})).toEqual([]);
  });
});
