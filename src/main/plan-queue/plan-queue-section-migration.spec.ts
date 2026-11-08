import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { LOOP_SCHEMA_VERSION, runLoopMigrations, runLoopMigrationsUpTo } from '../orchestration/loop-schema';
import { PlanQueueStore } from './plan-queue-store';
import { newPlanQueueItem } from './plan-queue-state';

let db: SqliteDriver;
beforeEach(() => { db = new Database(':memory:') as unknown as SqliteDriver; db.pragma('foreign_keys = ON'); });
afterEach(() => db.close());

/** A profile on the version before this migration, with a job and the history rows that point at it. */
function profileBeforeSections(): void {
  runLoopMigrationsUpTo(db, 53);
  db.prepare(`INSERT INTO plan_queue_runs (id, parent_instance_id, kind, workspace_cwd, status, config_json, started_at, updated_at)
    VALUES ('run-1', 'chat', 'plans', '/repo', 'running', '{}', 1, 1)`).run();
  db.prepare(`INSERT INTO plan_queue_items (id, run_id, document_path, state, round, created_at, updated_at, tokens, landing_automatic, round_activity_json)
    VALUES ('job-1', 'run-1', '/repo/docs/plans/big_plan.md', 'parked', 2, 5, 6, 77, 1, '[]')`).run();
  db.prepare(`INSERT INTO plan_queue_item_events (id, item_id, run_id, at, to_state, round, tokens) VALUES ('event-1', 'job-1', 'run-1', 5, 'parked', 2, 77)`).run();
  db.prepare(`INSERT INTO plan_queue_item_pins (item_id, document_sha256, document_bytes, unchecked_json, recorded_at) VALUES ('job-1', 'abc', 3, '[]', 5)`).run();
}

const insert = (id: string, section: number | null) => db.prepare(
  `INSERT INTO plan_queue_items (id, run_id, document_path, state, created_at, updated_at, section) VALUES (?, 'run-1', '/repo/docs/plans/big_plan.md', 'queued', 7, 7, ?)`).run(id, section);
const columns = () => db.prepare('PRAGMA table_info(plan_queue_items)').all<{ name: string }>().map(column => column.name);

describe('migration 054, the step number on a queue job', () => {
  it('keeps every row and its history on an existing database, and adds the column', () => {
    profileBeforeSections();
    const before = db.prepare('SELECT * FROM plan_queue_items').get<Record<string, unknown>>();
    runLoopMigrations(db);
    expect(db.prepare('SELECT * FROM plan_queue_items').get()).toEqual({ ...before, section: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_queue_item_events').get<{ n: number }>()?.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_queue_item_pins').get<{ n: number }>()?.n).toBe(1);
    expect(db.prepare('SELECT name FROM loop_migrations WHERE version = 54').get<{ name: string }>()?.name).toBe('054_plan_queue_item_section');
    expect(LOOP_SCHEMA_VERSION).toBe(54);
  });

  it('keeps the worker report on an existing job through the rebuild', () => {
    profileBeforeSections();
    const report = JSON.stringify({ summary: 'Built it.', asBuilt: 'Done.', checksRun: [], deferredChecks: [], followUps: [] });
    db.prepare("UPDATE plan_queue_items SET worker_report_json = ? WHERE id = 'job-1'").run(report);
    runLoopMigrations(db);
    expect(columns()).toContain('worker_report_json');
    expect(db.prepare("SELECT worker_report_json FROM plan_queue_items WHERE id = 'job-1'").get<{ worker_report_json: string }>()?.worker_report_json).toBe(report);
  });

  it('puts foreign keys back on, and the history still follows its job', () => {
    profileBeforeSections();
    runLoopMigrations(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.prepare("DELETE FROM plan_queue_items WHERE id = 'job-1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_queue_item_events').get<{ n: number }>()?.n).toBe(0);
  });

  it('lets one run hold a job per step of a document, but never two for the same step or two whole-document jobs', () => {
    profileBeforeSections();
    runLoopMigrations(db);
    insert('step-1', 1); insert('step-2', 2);
    expect(() => insert('again-2', 2)).toThrow(/UNIQUE/);
    // job-1 is the document's whole-document job already.
    expect(() => insert('again-whole', null)).toThrow(/UNIQUE/);
  });

  it('is not run twice, and the store reads and writes the step number', () => {
    profileBeforeSections();
    runLoopMigrations(db);
    runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    store.upsertItem(newPlanQueueItem('step-3', 'run-1', '/repo/docs/plans/big_plan.md', 9, { state: 'queued', section: 3 }));
    expect(store.getItem('step-3')?.section).toBe(3);
    expect(store.getItem('job-1')?.section).toBeUndefined();
  });

  it('adopts a column that an earlier build already added, as 053 does', () => {
    profileBeforeSections();
    db.exec('ALTER TABLE plan_queue_items ADD COLUMN section INTEGER;');
    runLoopMigrations(db);
    expect(columns().filter(name => name === 'section')).toHaveLength(1);
    insert('step-1', 1); insert('step-2', 2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_queue_item_events').get<{ n: number }>()?.n).toBe(1);
  });

  it('only needs the new index when an earlier build had already removed the old rule', () => {
    profileBeforeSections();
    runLoopMigrations(db);
    db.prepare('DELETE FROM loop_migrations WHERE version = 54').run();
    expect(() => runLoopMigrations(db)).not.toThrow();
    insert('step-1', 1);
  });

  it('is not stopped by a reference that was already broken before the rebuild', () => {
    profileBeforeSections();
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO plan_queue_item_events (id, item_id, run_id, at, to_state, round, tokens) VALUES ('orphan', 'no-such-job', 'run-1', 5, 'parked', 1, 0)`).run();
    db.pragma('foreign_keys = ON');
    expect(() => runLoopMigrations(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_queue_item_events').get<{ n: number }>()?.n).toBe(2);
  });

  it('builds the same table on a fresh database', () => {
    runLoopMigrations(db);
    db.prepare(`INSERT INTO plan_queue_runs (id, parent_instance_id, kind, workspace_cwd, status, config_json, started_at, updated_at)
      VALUES ('run-1', 'chat', 'plans', '/repo', 'running', '{}', 1, 1)`).run();
    expect(columns()).toContain('section');
    insert('step-1', 1); insert('step-2', 2);
    expect(() => insert('again-2', 2)).toThrow(/UNIQUE/);
  });
});
