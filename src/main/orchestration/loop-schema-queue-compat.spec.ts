import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations, runLoopMigrationsUpTo } from './loop-schema';

let db: SqliteDriver;
beforeEach(() => {
  db = new Database(':memory:') as unknown as SqliteDriver;
  db.exec('PRAGMA foreign_keys = ON');
  runLoopMigrationsUpTo(db, 30);
  db.exec(`INSERT INTO plan_queue_runs
    (id, parent_instance_id, kind, workspace_cwd, status, config_json, started_at, updated_at, tokens)
    VALUES ('saved-run', 'parent', 'plans', '/example', 'paused', '{}', 1, 1, 12);
    INSERT INTO plan_queue_items
    (id, run_id, document_path, state, created_at, updated_at, tokens)
    VALUES ('saved-item', 'saved-run', '/example/plan.md', 'queued', 1, 1, 25);`);
});
afterEach(() => db.close());

const cases = [
  { label: 'main version 30', history: 30, legacy: false, local: false, port: null, conflicts: 0 },
  { label: 'history version 31', history: 31, legacy: false, local: false, port: null, conflicts: 0 },
  { label: 'history and spend version 32', history: 32, legacy: false, local: false, port: null, conflicts: 0 },
  { label: 'legacy version 31 port', history: 30, legacy: true, local: false, port: 9876, conflicts: 0 },
  { label: 'local versions 40 and 41', history: 30, legacy: false, local: true, port: 9876, conflicts: 2 },
  { label: 'legacy port plus local versions 40 and 41', history: 30, legacy: true, local: true, port: 9876, conflicts: 2 },
];

describe('queue migration compatibility', () => {
  it.each(cases)('upgrades $label without losing saved rows or changing old migration receipts', scenario => {
    runLoopMigrationsUpTo(db, scenario.history);
    if (scenario.legacy) {
      // Historical local SQL used 31 before Phase C's history migration landed.
      db.exec(`ALTER TABLE plan_queue_items ADD COLUMN livetest_port INTEGER;
        UPDATE plan_queue_items SET livetest_port = 9876;
        INSERT INTO loop_migrations VALUES (31, '031_plan_queue_item_livetest_port', 1);`);
    }
    if (scenario.local) {
      if (!scenario.legacy) db.exec('ALTER TABLE plan_queue_items ADD COLUMN livetest_port INTEGER;');
      db.exec(`ALTER TABLE plan_queue_items ADD COLUMN base_conflicts INTEGER NOT NULL DEFAULT 0;
        UPDATE plan_queue_items SET livetest_port = 9876, base_conflicts = 2;
        INSERT INTO loop_migrations VALUES (40, '040_plan_queue_item_livetest_port', 1);
        INSERT INTO loop_migrations VALUES (41, '041_plan_queue_item_base_conflicts', 1);`);
    }
    const ledgerBefore = db.prepare('SELECT * FROM loop_migrations ORDER BY version').all<{ version: number }>();
    if (scenario.history >= 31) {
      db.exec(`INSERT INTO plan_queue_item_events VALUES
        ('before-event', 'saved-item', 'saved-run', 1, 'queued', 'working', NULL, 'keep before event', 0, 25);`);
    }
    if (scenario.history >= 32) {
      db.exec(`INSERT INTO plan_queue_spend VALUES
        ('before-spend', 'saved-item', 'saved-run', 'worker', 0, 'fixture', NULL, 20, 5, NULL, 'unknown', 1);`);
    }

    runLoopMigrations(db);

    expect(db.prepare('SELECT id, state, tokens, livetest_port, base_conflicts, unpriced_tokens FROM plan_queue_items').get())
      .toEqual({ id: 'saved-item', state: 'queued', tokens: 25, livetest_port: scenario.port,
        base_conflicts: scenario.conflicts, unpriced_tokens: 25 });
    expect(db.prepare('SELECT id, status, tokens, unpriced_tokens FROM plan_queue_runs').get())
      .toEqual({ id: 'saved-run', status: 'paused', tokens: 12, unpriced_tokens: 12 });
    for (const receipt of ledgerBefore) {
      expect(db.prepare('SELECT * FROM loop_migrations WHERE version = ?').get(receipt.version)).toEqual(receipt);
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plan_queue_%' ORDER BY name")
      .all<{ name: string }>().map(row => row.name)).toEqual([
      'plan_queue_item_events', 'plan_queue_item_pins', 'plan_queue_items', 'plan_queue_runs',
      'plan_queue_spend', 'plan_queue_triage_decisions', 'plan_queue_verdicts',
    ]);
    db.exec(`INSERT INTO plan_queue_item_events VALUES
      ('after-event', 'saved-item', 'saved-run', 2, 'working', 'awaiting-slot', NULL, 'keep after event', 0, 25);
      INSERT INTO plan_queue_spend VALUES
      ('after-spend', 'saved-item', 'saved-run', 'worker', 0, 'fixture', NULL, 15, 4, NULL, 'unknown', 2);`);
    const ledger = db.prepare('SELECT * FROM loop_migrations ORDER BY version').all();
    const events = db.prepare('SELECT * FROM plan_queue_item_events ORDER BY id').all();
    const spend = db.prepare('SELECT * FROM plan_queue_spend ORDER BY id').all();

    runLoopMigrations(db);

    expect(db.prepare('SELECT * FROM loop_migrations ORDER BY version').all()).toEqual(ledger);
    expect(db.prepare('SELECT * FROM plan_queue_item_events ORDER BY id').all()).toEqual(events);
    expect(db.prepare('SELECT * FROM plan_queue_spend ORDER BY id').all()).toEqual(spend);
    expect(events).toHaveLength(scenario.history >= 31 ? 2 : 1);
    expect(spend).toHaveLength(scenario.history >= 32 ? 2 : 1);
    expect(db.prepare('SELECT name FROM loop_migrations WHERE version = 31').get()).toEqual({
      name: scenario.legacy ? '031_plan_queue_item_livetest_port' : '031_plan_queue_history',
    });
  });
});
