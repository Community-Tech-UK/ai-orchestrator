import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  computeMigrationChecksum,
  createMigrationsTable,
  createTables,
  getAppliedMigrations,
  MIGRATIONS,
  runMigrations,
} from './rlm-schema';

describe('RLM migration recovery', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
  });

  afterEach(() => db.close());

  it('upgrades a partially migrated profile without rewriting its existing history', () => {
    const prefix = MIGRATIONS.slice(0, 3);
    for (const migration of prefix) {
      db.exec(migration.up);
      db.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)')
        .run(migration.name, 1, computeMigrationChecksum(migration));
    }
    const before = getAppliedMigrations(db);
    const applied = vi.fn();
    const complete = vi.fn();

    runMigrations(db, applied, complete);

    const after = getAppliedMigrations(db);
    expect(after.slice(0, prefix.length)).toEqual(before);
    expect(after.map(row => row.name)).toEqual(MIGRATIONS.map(migration => migration.name));
    expect(applied.mock.calls.map(([name]) => name)).toEqual(
      MIGRATIONS.slice(prefix.length).map(migration => migration.name),
    );
    expect(complete).toHaveBeenCalledExactlyOnceWith(MIGRATIONS.length - prefix.length);
  });

  it('leaves migration history untouched and releases its lock when nothing is pending', () => {
    runMigrations(db);
    const before = getAppliedMigrations(db);
    const applied = vi.fn();
    const complete = vi.fn();

    runMigrations(db, applied, complete);

    expect(getAppliedMigrations(db)).toEqual(before);
    expect(applied).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  });

  it('rolls back migration SQL and history together when a migration body fails', () => {
    runMigrations(db);
    const before = getAppliedMigrations(db);
    const migration = {
      name: 'test_migration_body_failure',
      up: 'CREATE TABLE migration_rollback_probe (id INTEGER); INSERT INTO missing_migration_table VALUES (1);',
      down: 'DROP TABLE migration_rollback_probe;',
    };
    MIGRATIONS.push(migration);
    try {
      expect(() => runMigrations(db)).toThrow('Failed to apply migration "test_migration_body_failure"');
      expect(getAppliedMigrations(db)).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'migration_rollback_probe'").get())
        .toBeUndefined();
      migration.up = 'CREATE TABLE migration_rollback_probe (id INTEGER);';
      runMigrations(db);
      expect(getAppliedMigrations(db).at(-1)?.name).toBe(migration.name);
    } finally {
      MIGRATIONS.pop();
    }
  });
});
