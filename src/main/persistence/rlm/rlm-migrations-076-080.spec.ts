import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  computeMigrationChecksum,
  createMigrationsTable,
  createTables,
  MIGRATIONS,
  runMigrations,
} from './rlm-schema';
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
    for (const migration of [...RLM_MIGRATIONS_076_080].reverse()) {
      db.exec(migration.down);
    }
    expect(columnNames(db, 'browser_audit_entries')).not.toContain('reason');
  });
});

describe('078_automation_pre_check', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    db.prepare(`
      INSERT INTO automations
        (id, name, enabled, active, workspace_id, schedule_type, schedule_json, trigger_json,
         missed_run_policy, concurrency_policy, action_json, created_at, updated_at)
      VALUES ('a1', 'Checked job', 1, 1, '/tmp', 'cron', '{}', '{}', 'notify', 'skip', '{}', 1, 1)
    `).run();
  });

  afterEach(() => db.close());

  it('adds the outcome column and check state table', () => {
    expect(columnNames(db, 'automation_runs')).toContain('outcome');
    expect(columnNames(db, 'automation_check_state')).toEqual(expect.arrayContaining([
      'automation_id', 'baseline_hash', 'pending_run_id', 'failure_streak', 'updated_at',
    ]));
  });

  it('cascades check state when the automation is deleted', () => {
    db.prepare(`INSERT INTO automation_check_state
      (automation_id, baseline_hash, failure_streak, updated_at) VALUES ('a1', 'h', 0, 1)`).run();
    db.prepare(`DELETE FROM automations WHERE id = 'a1'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM automation_check_state`).get<{ n: number }>()?.n).toBe(0);
  });
});


describe('080_helper_budget_notice_day', () => {
  it('registers once, preserves its day on a repeated migration run and rolls back cleanly', () => {
    const db = defaultDriverFactory(':memory:');
    try {
      createTables(db); createMigrationsTable(db); runMigrations(db);
      db.prepare('INSERT INTO local_ai_helper_budget_notice (singleton, day) VALUES (1, ?)').run('2026-10-19');
      expect(() => db.prepare('INSERT INTO local_ai_helper_budget_notice (singleton, day) VALUES (2, ?)').run('2026-10-20')).toThrow();
      runMigrations(db);
      expect(db.prepare('SELECT * FROM local_ai_helper_budget_notice').all()).toEqual([{singleton: 1, day: '2026-10-19'}]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = '080_helper_budget_notice_day'").get()).toEqual({n: 1});
      db.exec(RLM_MIGRATIONS_076_080.find(m => m.name === '080_helper_budget_notice_day')!.down);
      expect(columnNames(db, 'local_ai_helper_budget_notice')).toEqual([]);
    } finally { db.close(); }
  });
});

describe('merged migration histories', () => {
  it.each([
    { branch: 'token levers', missing: ['079_global_pause_batches', '080_connectors'] },
    { branch: 'main', missing: ['078_automation_pre_check', '079_automation_thread_prompt_delivery', '080_helper_budget_notice_day'] },
  ])('upgrades an existing $branch database without reapplying its migrations', ({ missing }) => {
    const db = defaultDriverFactory(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      createTables(db);
      createMigrationsTable(db);
      runMigrations(db);
      // Recreate the parent's schema and durable migration ledger. Shared
      // numeric prefixes must not cause one branch's migrations to hide the other.
      for (const migration of [...RLM_MIGRATIONS_076_080].reverse()) {
        if (!missing.includes(migration.name)) continue;
        db.exec(migration.down);
        db.prepare('DELETE FROM _migrations WHERE name = ?').run(migration.name);
      }
      const applied: string[] = [];
      runMigrations(db, name => applied.push(name));
      expect(applied).toEqual(missing);
      expect(columnNames(db, 'automation_runs')).toEqual(expect.arrayContaining(['outcome', 'thread_prompt_delivered']));
      expect(columnNames(db, 'orchestrator_mcp_servers')).toContain('connector_json');
      expect(columnNames(db, 'global_pause_entries')).toContain('batch_id');
      expect(columnNames(db, 'automation_check_state')).toContain('baseline_hash');
      expect(columnNames(db, 'local_ai_helper_budget_notice')).toContain('day');
      expect(columnNames(db, 'connector_auth')).toContain('encrypted_json');
      const repeated = vi.fn();
      runMigrations(db, repeated);
      expect(repeated).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});

describe('078_browser_approval_request_reason', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('adds a nullable request_reason column and leaves old approval rows readable', () => {
    const migration = MIGRATIONS.find((item) => item.name === '078_browser_approval_request_reason')!;
    expect(migration).toBeDefined();
    for (const earlier of MIGRATIONS.slice(0, MIGRATIONS.indexOf(migration))) {
      db.exec(earlier.up);
      db.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)')
        .run(earlier.name, 1, computeMigrationChecksum(earlier));
    }
    db.prepare(`INSERT INTO browser_approval_requests
      (id, request_id, instance_id, provider, profile_id, tool_name, action, action_class,
      proposed_grant_json, status, created_at, expires_at)
      VALUES ('old', 'old', 'session', 'codex', 'computer', 'browser.click', 'click', 'input', '{}', 'denied', 1, 100)`)
      .run();
    expect(columnNames(db, 'browser_approval_requests')).not.toContain('request_reason');

    runMigrations(db);
    runMigrations(db);

    expect(columnNames(db, 'browser_approval_requests')).toContain('request_reason');
    expect(db.prepare('SELECT status, request_reason FROM browser_approval_requests').get())
      .toEqual({ status: 'denied', request_reason: null });
  });

  it('rolls the column back on down', () => {
    runMigrations(db);
    const migration = MIGRATIONS.find((item) => item.name === '078_browser_approval_request_reason')!;
    db.exec(migration.down);
    expect(columnNames(db, 'browser_approval_requests')).not.toContain('request_reason');
  });
});
