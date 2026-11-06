import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { computeMigrationChecksum, createMigrationsTable, createTables, getAppliedMigrations, MIGRATIONS, runMigrations } from './rlm-schema';
import { RLM_MIGRATIONS_081_085 } from './rlm-migrations-081-085';
import { CostTracker } from '../../core/system/cost-tracker';

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

describe('082_cost_entry_origin', () => {
  let db: SqliteDriver;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
  });
  afterEach(() => db.close());

  it('registers origin after the existing browser migration', () => {
    expect(RLM_MIGRATIONS_081_085.map(migration => migration.name)).toEqual([
      '081_browser_audit_command_id', '081_browser_login_portal_accounts', '082_cost_entry_origin',
    ]);
  });

  it('upgrades historical rows without inventing an origin and is inert on the next startup', () => {
    const migration = RLM_MIGRATIONS_081_085.find(migration => migration.name === '082_cost_entry_origin')!;
    expect(migration).toBeDefined();
    db.exec(migration.down);
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(migration.name);
    db.exec(`INSERT INTO cost_entries
      (id, timestamp, instance_id, session_id, model, input_tokens, output_tokens, cost)
      VALUES ('historical', 1, 'instance', 'session', 'model', 0, 0, 0)`);
    const applied: string[] = [];
    runMigrations(db, name => applied.push(name));
    runMigrations(db, name => applied.push(name));
    expect(applied).toEqual(['082_cost_entry_origin']);
    expect(db.prepare('SELECT origin FROM cost_entries').get()).toEqual({ origin: null });
    const restored = new CostTracker(); restored.setDatabase(db);
    expect(restored.getEntries()[0]).not.toHaveProperty('origin');
  });

  it('persists and reloads user, machine and future open origin tags, including entries recorded before attach', () => {
    const tracker = new CostTracker();
    for (const origin of ['user', 'machine', 'self-wakeup']) {
      tracker.recordUsage(origin, 'session', 'model', 0, 0, 0, 0, 0, 0, false, { origin });
    }
    tracker.setDatabase(db);
    const restored = new CostTracker(); restored.setDatabase(db);
    expect(restored.getEntries().map(entry => entry.origin).sort()).toEqual(['machine', 'self-wakeup', 'user']);
    expect(db.prepare('SELECT origin FROM cost_entries ORDER BY origin').all()).toEqual([
      { origin: 'machine' }, { origin: 'self-wakeup' }, { origin: 'user' },
    ]);
  });

  it('rolls back only origin and preserves existing pause, connector and browser columns', () => {
    const migration = RLM_MIGRATIONS_081_085.find(migration => migration.name === '082_cost_entry_origin')!;
    expect(migration).toBeDefined();
    db.exec(migration.down);
    expect(db.prepare('PRAGMA table_info(cost_entries)').all<{ name: string }>().map(row => row.name)).not.toContain('origin');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('global_pause_batches', 'connector_auth')").all()).toHaveLength(2);
    expect(db.prepare('PRAGMA table_info(browser_audit_entries)').all<{ name: string }>().map(row => row.name)).toContain('command_id');
  });
});

describe('merged browser migrations', () => {
  it.each(RLM_MIGRATIONS_081_085.map((m) => m.name))('upgrades a database already containing %s', (appliedName) => {
    const db = defaultDriverFactory(':memory:');
    try {
      createTables(db);
      createMigrationsTable(db);
      const preapplied = MIGRATIONS.filter((m) => m.name < '081' || m.name === appliedName);
      for (const migration of preapplied) {
        db.exec(migration.up);
        db.prepare('INSERT INTO _migrations(name, applied_at, checksum) VALUES (?, ?, ?)')
          .run(migration.name, 1, computeMigrationChecksum(migration));
      }

      db.prepare(`INSERT INTO browser_audit_entries
        (id, provider, action, tool_name, action_class, decision, outcome, summary, request_id, created_at)
        VALUES ('audit-placeholder', 'codex', 'click', 'browser.click', 'input', 'requires_user', 'not_run',
          'Approval required', 'approval-placeholder', 1)`).run();
      db.prepare(`INSERT INTO automations
        (id, name, schedule_type, schedule_json, missed_run_policy, concurrency_policy, action_json, created_at, updated_at)
        VALUES ('job-placeholder', 'Job placeholder', 'cron', '{}', 'skip', 'skip', ?, 1, 1)`)
        .run(JSON.stringify({ prompt: 'Placeholder', workingDirectory: '/repo' }));
      const preappliedNames = new Set(preapplied.map((m) => m.name));
      const expectedPending = MIGRATIONS.filter((m) => !preappliedNames.has(m.name)).map((m) => m.name);
      const applied: string[] = [];
      runMigrations(db, (name) => applied.push(name));

      expect(applied).toEqual(expectedPending);
      const ledger = getAppliedMigrations(db);
      expect(ledger.map(({ name, checksum }) => ({ name, checksum })).sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual(MIGRATIONS.map((migration) => ({ name: migration.name, checksum: computeMigrationChecksum(migration) }))
          .sort((a, b) => a.name.localeCompare(b.name)));
      const afterRestart: string[] = [];
      runMigrations(db, (name) => afterRestart.push(name));
      expect(afterRestart).toEqual([]);
      expect(getAppliedMigrations(db)).toEqual(ledger);
      expect(db.prepare('SELECT id, request_id, command_id FROM browser_audit_entries').get()).toEqual({
        id: 'audit-placeholder', request_id: 'approval-placeholder', command_id: null,
      });
      const action = db.prepare('SELECT action_json FROM automations').get<{ action_json: string }>()!;
      expect(JSON.parse(action.action_json)).toEqual({
        prompt: 'Placeholder', workingDirectory: '/repo', maxRunMinutes: 30, maxProcessedTokens: 30_000_000,
      });
      expect(db.prepare("PRAGMA table_info('browser_audit_entries')").all<{ name: string }>().map((row) => row.name))
        .toContain('command_id');
      expect(db.prepare("PRAGMA table_info('browser_login_portal_recipes')").all<{ name: string }>().map((row) => row.name))
        .toContain('portal_path');
    } finally {
      db.close();
    }
  });
});
