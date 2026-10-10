import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';
import { RLM_MIGRATIONS_076_080 } from './rlm-migrations-076-080';

function columnNames(db: SqliteDriver, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>().map((c) => c.name);
}

describe('076_browser_audit_reason', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('adds the nullable reason column to browser_audit_entries', () => {
    expect(columnNames(db, 'browser_audit_entries')).toContain('reason');
  });

  it('rolls the column back on down', () => {
    for (const migration of RLM_MIGRATIONS_076_080) {
      db.exec(migration.down);
    }
    expect(columnNames(db, 'browser_audit_entries')).not.toContain('reason');
  });
});
