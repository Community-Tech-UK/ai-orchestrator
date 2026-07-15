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

  it('creates verification run storage with loop and instance lookup indexes through migration 048', () => {
    const db = openMigratedDb();

    expect(db.prepare('SELECT name FROM _migrations WHERE name = ?').get<{ name: string }>('048_verification_runs')).toEqual({ name: '048_verification_runs' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verification_runs'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_verification_runs_loop_started'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_verification_runs_instance_started'").get()).toBeDefined();
  });

  it('adds persisted automation trigger configuration through migration 049', () => {
    const db = openMigratedDb();

    expect(db.prepare('SELECT name FROM _migrations WHERE name = ?').get<{ name: string }>('049_automation_trigger_configuration')).toEqual({ name: '049_automation_trigger_configuration' });
    expect(db.prepare('PRAGMA table_info(automations)').all<{ name: string }>().map((column) => column.name)).toContain('trigger_json');
  });
});
