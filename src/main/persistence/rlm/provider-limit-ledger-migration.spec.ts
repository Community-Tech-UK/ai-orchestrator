import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('provider-limit ledger RLM migration', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates the provider_limit_events table and its active lookup index through migration 047', () => {
    const db = openMigratedDb();
    expect(db.prepare('SELECT name FROM _migrations WHERE name = ?').get<{ name: string }>('047_provider_limit_events')).toEqual({ name: '047_provider_limit_events' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_limit_events'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_provider_limit_events_active'").get()).toBeDefined();
  });
});
