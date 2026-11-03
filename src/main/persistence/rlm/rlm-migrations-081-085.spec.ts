import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { computeMigrationChecksum, createMigrationsTable, createTables, MIGRATIONS, runMigrations } from './rlm-schema';
import { RLM_MIGRATIONS_081_085 } from './rlm-migrations-081-085';

describe('081_browser_audit_command_id', () => {
  let db: SqliteDriver;
  const migration = RLM_MIGRATIONS_081_085.find((m) => m.name === '081_browser_audit_command_id')!;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('upgrades existing audits without changing approval IDs or inventing a dispatch identity', () => {
    db.exec(migration.down);
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(migration.name);
    db.prepare(`INSERT INTO browser_audit_entries
      (id, provider, action, tool_name, action_class, decision, outcome, summary, redaction_applied, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'historical-placeholder', 'codex', 'click', 'browser.click', 'input', 'requires_user', 'not_run',
      'Approval required', 1, 'approval-placeholder', 1,
    );

    runMigrations(db);
    runMigrations(db); // A second startup must not apply ALTER TABLE again.
    expect(db.prepare('SELECT request_id, command_id FROM browser_audit_entries').get()).toEqual({
      request_id: 'approval-placeholder', command_id: null,
    });
    expect(db.prepare("PRAGMA index_list('browser_audit_entries')").all<{ name: string }>()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'idx_browser_audit_command' })]),
    );
  });

  it('rolls the nullable command column and lookup index back together', () => {
    db.exec(migration.down);
    expect(db.prepare("PRAGMA table_info('browser_audit_entries')").all<{ name: string }>().map((row) => row.name))
      .not.toContain('command_id');
    expect(db.prepare("PRAGMA index_list('browser_audit_entries')").all<{ name: string }>().map((row) => row.name))
      .not.toContain('idx_browser_audit_command');
    db.exec(migration.up);
    expect(db.prepare("PRAGMA table_info('browser_audit_entries')").all<{ name: string }>().map((row) => row.name))
      .toContain('command_id');
  });
});

describe('merged browser migrations', () => {
  it.each(RLM_MIGRATIONS_081_085.map((m) => m.name))('upgrades a database already containing %s', (appliedName) => {
    const db = defaultDriverFactory(':memory:');
    try {
      createTables(db);
      createMigrationsTable(db);
      for (const migration of MIGRATIONS.filter((m) => m.name < '081' || m.name === appliedName)) {
        db.exec(migration.up);
        db.prepare('INSERT INTO _migrations(name, applied_at, checksum) VALUES (?, ?, ?)')
          .run(migration.name, 1, computeMigrationChecksum(migration));
      }

      const applied: string[] = [];
      runMigrations(db, (name) => applied.push(name));
      runMigrations(db, (name) => applied.push(name));

      expect(applied).toEqual(RLM_MIGRATIONS_081_085.filter((m) => m.name !== appliedName).map((m) => m.name));
      expect(db.prepare("PRAGMA table_info('browser_audit_entries')").all<{ name: string }>().map((row) => row.name))
        .toContain('command_id');
      expect(db.prepare("PRAGMA table_info('browser_login_portal_recipes')").all<{ name: string }>().map((row) => row.name))
        .toContain('portal_path');
    } finally {
      db.close();
    }
  });
});
