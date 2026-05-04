import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { BrowserAuditStore } from './browser-audit-store';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('BrowserAuditStore', () => {
  let db: SqliteDriver;
  let store: BrowserAuditStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = createDb();
    store = new BrowserAuditStore(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('records audit entries with generated ids and timestamps', () => {
    const entry = store.record({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      targetId: 'target-1',
      action: 'navigate',
      toolName: 'browser.navigate',
      actionClass: 'navigate',
      origin: 'http://localhost:4567',
      url: 'http://localhost:4567',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Navigated within allowed origin',
      redactionApplied: true,
      requestId: 'request-1',
      grantId: 'grant-1',
      autonomous: true,
    });

    expect(entry).toMatchObject({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      targetId: 'target-1',
      action: 'navigate',
      toolName: 'browser.navigate',
      actionClass: 'navigate',
      decision: 'allowed',
      outcome: 'succeeded',
      redactionApplied: true,
      requestId: 'request-1',
      grantId: 'grant-1',
      autonomous: true,
      createdAt: 1_000,
    });
    expect(entry.id).toBeTruthy();
  });

  it('lists newest audit entries first and caps the default limit at 100', () => {
    for (let index = 0; index < 105; index++) {
      vi.setSystemTime(1_000 + index);
      store.record({
        instanceId: index % 2 === 0 ? 'instance-even' : 'instance-odd',
        provider: 'claude',
        profileId: index % 2 === 0 ? 'profile-even' : 'profile-odd',
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: `Snapshot ${index}`,
        redactionApplied: true,
      });
    }

    const entries = store.list({});
    expect(entries).toHaveLength(100);
    expect(entries[0]?.summary).toBe('Snapshot 104');
    expect(entries.at(-1)?.summary).toBe('Snapshot 5');

    const filtered = store.list({ profileId: 'profile-even', instanceId: 'instance-even', limit: 3 });
    expect(filtered).toHaveLength(3);
    expect(filtered.every((entry) => entry.profileId === 'profile-even')).toBe(true);
    expect(filtered.every((entry) => entry.instanceId === 'instance-even')).toBe(true);
  });
});
