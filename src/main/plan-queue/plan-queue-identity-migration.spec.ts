/**
 * Migration 044 (`source_kind` and `sort_key`, step 6.2 of the autonomy-and-Linear programme).
 *
 * The first block builds a database like a real install: every migration applied except 044, which came later than
 * 045 to 052. The second block repeats the checks on a copy of James's real queue database and runs only when
 * `PLAN_QUEUE_REAL_DB_COPY` names that copy (made read-only from the live file, kept under `_scratch/`; see the
 * plan's as-built notes). Nothing here ever opens the live database.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { openSqliteWasmFileCopy, openSqliteWasmFileReadOnly } from '../db/sqlite-wasm-driver';
import { LOOP_MIGRATIONS, runLoopMigrations, runLoopMigrationsUpTo } from '../orchestration/loop-schema';
import { PlanQueueStore } from './plan-queue-store';
import { buildSortKey } from './plan-queue-sort-key';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';

/** A database as a real install has it: every migration but 044 applied. */
function databaseWithout044(): SqliteDriver {
  const db = new Database(':memory:') as unknown as SqliteDriver;
  db.exec('PRAGMA foreign_keys = ON');
  runLoopMigrationsUpTo(db, 43);
  for (const migration of LOOP_MIGRATIONS.filter(entry => entry.version > 43 && entry.version !== 44)) {
    if (typeof migration.up === 'string') db.exec(migration.up); else migration.up(db);
    db.prepare('INSERT INTO loop_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, 1);
  }
  return db;
}

const columnNames = (db: SqliteDriver): string[] =>
  db.prepare('PRAGMA table_info(plan_queue_items)').all<{ name: string }>().map(column => column.name);

function seedLegacyRows(db: SqliteDriver): void {
  db.prepare(`INSERT INTO plan_queue_runs (id, parent_instance_id, kind, workspace_cwd, status, config_json, started_at, updated_at)
    VALUES ('run-a', 'parent', 'plans', '/repo', 'running', '{}', 1, 1), ('run-b', 'parent', 'livetests', '/repo', 'completed', '{}', 2, 2)`).run();
  const insert = db.prepare(`INSERT INTO plan_queue_items (id, run_id, document_path, state, created_at, updated_at, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Inserted out of order, with a tie on created_at, so the legacy order (created_at, id) is not insertion order.
  insert.run('i-3', 'run-a', '/repo/docs/plans/c_plan.md', 'queued', 300, 300, 'third');
  insert.run('i-1', 'run-a', '/repo/docs/plans/a_plan.md', 'landed', 100, 100, 'first');
  insert.run('i-2b', 'run-a', '/repo/docs/plans/b2_plan.md', 'parked', 200, 200, 'second, later id');
  insert.run('i-2a', 'run-a', '/repo/docs/plans/b1_plan.md', 'queued', 200, 200, 'second, earlier id');
  insert.run('i-9', 'run-b', '/repo/docs/plans/a_plan.md', 'queued', 50, 50, 'same document, other run');
}

let db: SqliteDriver;
afterEach(() => { db?.close(); });

describe('migration 044 on a database that already has 045 to 052', () => {
  beforeEach(() => { db = databaseWithout044(); });

  it('is the only thing missing, and is applied once', () => {
    expect(columnNames(db)).not.toContain('source_kind');
    expect(columnNames(db)).not.toContain('sort_key');
    runLoopMigrations(db);
    runLoopMigrations(db);
    const receipts = db.prepare('SELECT version, name FROM loop_migrations ORDER BY version').all<{ version: number; name: string }>();
    expect(receipts).toEqual(LOOP_MIGRATIONS.map(({ version, name }) => ({ version, name })));
    expect(receipts.filter(receipt => receipt.version === 44)).toEqual([{ version: 44, name: '044_plan_queue_item_source_sort' }]);
    expect(columnNames(db)).toEqual(expect.arrayContaining(['source_kind', 'sort_key']));
  });

  it('adds the columns without rebuilding the table: rows, row numbers, the unique key and every old value stay', () => {
    seedLegacyRows(db);
    const oldColumns = columnNames(db);
    const before = db.prepare(`SELECT rowid, ${oldColumns.join(', ')} FROM plan_queue_items ORDER BY rowid`).all();
    const tableSqlBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'plan_queue_items'").get<{ sql: string }>()!.sql;

    runLoopMigrations(db);

    expect(db.prepare(`SELECT rowid, ${oldColumns.join(', ')} FROM plan_queue_items ORDER BY rowid`).all()).toEqual(before);
    const tableSqlAfter = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'plan_queue_items'").get<{ sql: string }>()!.sql;
    // An ADD COLUMN only inserts the two column definitions into the stored table text; a rebuild would have rewritten it.
    expect(tableSqlAfter.replace(", source_kind TEXT NOT NULL DEFAULT 'markdown'", '').replace(", sort_key TEXT NOT NULL DEFAULT ''", '')).toBe(tableSqlBefore);
    // Migration 054 took the table-level (run, document) rule off and put a unique index on (run, document, step) in its
    // place; adding the columns must leave that index alone, so a second whole-document job still collides.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_plan_queue_items_step'").all()).toHaveLength(1);
    expect(db.prepare('SELECT source_kind, sort_key FROM plan_queue_items').all()).toEqual(Array(5).fill({ source_kind: 'markdown', sort_key: '' }));
    expect(() => db.prepare(`INSERT INTO plan_queue_items (id, run_id, document_path, state, created_at, updated_at)
      VALUES ('dup', 'run-a', '/repo/docs/plans/a_plan.md', 'queued', 1, 1)`).run()).toThrow(/UNIQUE/);
  });

  it('keeps the order every existing run was worked in', () => {
    seedLegacyRows(db);
    const legacyOrder = (runId: string) => db.prepare('SELECT id FROM plan_queue_items WHERE run_id = ? ORDER BY created_at, id').all<{ id: string }>(runId).map(row => row.id);
    const expected = { 'run-a': legacyOrder('run-a'), 'run-b': legacyOrder('run-b') };
    expect(expected['run-a']).toEqual(['i-1', 'i-2a', 'i-2b', 'i-3']);

    runLoopMigrations(db);
    const store = new PlanQueueStore(db);

    expect(store.listItems('run-a').map(item => item.id)).toEqual(expected['run-a']);
    expect(store.listItems('run-b').map(item => item.id)).toEqual(expected['run-b']);
    expect(store.listRunSnapshots(10).find(snapshot => snapshot.run.id === 'run-a')!.items.map(item => item.id)).toEqual(expected['run-a']);
    expect(store.listItems('run-a').every(item => item.sourceKind === 'markdown' && item.sortKey === '')).toBe(true);
  });

  it('orders a new run by its sort keys, not by when its rows were created', () => {
    runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    const run: PlanQueueRun = { id: 'run-new', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo', status: 'running',
      config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
    store.upsertRun(run);
    // Created in the reverse of the order their keys put them in, and one is "urgent".
    store.upsertItem(newPlanQueueItem('late-low', 'run-new', '/repo/x_plan.md', 1, { sortKey: buildSortKey({ priority: 4, discoveryIndex: 0 }) }));
    store.upsertItem(newPlanQueueItem('mid-none', 'run-new', '/repo/y_plan.md', 2, { sortKey: buildSortKey({ discoveryIndex: 1 }) }));
    store.upsertItem(newPlanQueueItem('early-urgent', 'run-new', '/repo/z_plan.md', 3, { sortKey: buildSortKey({ priority: 1, discoveryIndex: 2 }) }));
    expect(store.listItems('run-new').map(item => item.id)).toEqual(['early-urgent', 'late-low', 'mid-none']);
  });

  it('does not let a later save of a stale snapshot change the stored kind or key', () => {
    runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    store.upsertRun({ id: 'run-s', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo', status: 'running',
      config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null });
    const key = buildSortKey({ priority: 2, discoveryIndex: 0 });
    store.upsertItem(newPlanQueueItem('keep', 'run-s', '/repo/k_plan.md', 1, { sortKey: key }));
    store.upsertItem({ ...newPlanQueueItem('keep', 'run-s', '/repo/k_plan.md', 1), state: 'queued' });
    expect(store.getItem('keep')).toMatchObject({ state: 'queued', sortKey: key, sourceKind: 'markdown' });
  });

  it('crash window: a failure part-way leaves neither column and no receipt, so the next start applies it whole', () => {
    // A half-applied earlier attempt: one of the two columns already exists, so the migration's second statement fails.
    db.exec("ALTER TABLE plan_queue_items ADD COLUMN sort_key TEXT NOT NULL DEFAULT ''");
    expect(() => runLoopMigrations(db)).toThrow(/duplicate column name/i);
    expect(columnNames(db)).not.toContain('source_kind');
    expect(db.prepare('SELECT COUNT(*) AS count FROM loop_migrations WHERE version = 44').get<{ count: number }>()!.count).toBe(0);
  });
});

const realCopy = process.env['PLAN_QUEUE_REAL_DB_COPY'];

describe.skipIf(!realCopy || !existsSync(realCopy))('migration 044 on a copy of the real queue database', () => {
  let before: SqliteDriver;
  beforeEach(() => {
    // Both are in-memory images read from the kept copy, which is never written: the "before" is read-only, and the
    // other is a writable copy of it that gets migrated.
    before = openSqliteWasmFileReadOnly(realCopy!);
    db = openSqliteWasmFileCopy(realCopy!);
  });
  afterEach(() => { before.close(); });

  const queueTables = (handle: SqliteDriver): string[] =>
    handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plan_queue_%' ORDER BY name").all<{ name: string }>().map(row => row.name);

  it('is a real install: 044 is missing and 045 to 052 are present', () => {
    const versions = before.prepare('SELECT version FROM loop_migrations').all<{ version: number }>().map(row => row.version);
    expect(versions).not.toContain(44);
    expect(versions).toContain(52);
  });

  it('keeps every row of every queue table, and every old column of every item, exactly', () => {
    const oldColumns = columnNames(before);
    const tables = queueTables(before);
    const counts = (handle: SqliteDriver) => Object.fromEntries(tables.map(table => [table, handle.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()!.count]));
    const itemRows = (handle: SqliteDriver) => handle.prepare(`SELECT rowid, ${oldColumns.join(', ')} FROM plan_queue_items ORDER BY rowid`).all();
    const countsBefore = counts(before);
    expect(countsBefore['plan_queue_items']).toBeGreaterThan(0);

    runLoopMigrations(db);

    expect(queueTables(db)).toEqual(tables);
    expect(counts(db)).toEqual(countsBefore);
    expect(itemRows(db)).toEqual(itemRows(before));
    expect(db.prepare("SELECT COUNT(*) AS count FROM plan_queue_items WHERE source_kind != 'markdown' OR sort_key != ''").get<{ count: number }>()!.count).toBe(0);
  });

  it('keeps the order of every run, and every existing store query returns what it did', () => {
    const runIds = before.prepare('SELECT id FROM plan_queue_runs').all<{ id: string }>().map(row => row.id);
    const legacyOrder = Object.fromEntries(runIds.map(id => [id, before.prepare('SELECT id FROM plan_queue_items WHERE run_id = ? ORDER BY created_at, id').all<{ id: string }>(id).map(row => row.id)]));

    runLoopMigrations(db);
    // The same clock for both, so the health numbers (which look back from "now") can be compared.
    const now = () => Date.now() - (Date.now() % 3_600_000);
    const after = new PlanQueueStore(db, now);
    // The store reads the unmigrated copy too, for every query that does not order by the new column.
    const old = new PlanQueueStore(before, now);

    for (const id of runIds) expect(after.listItems(id).map(item => item.id), id).toEqual(legacyOrder[id]);
    const snapshots = after.listRunSnapshots(100_000);
    for (const snapshot of snapshots) expect(snapshot.items.map(item => item.id), snapshot.run.id).toEqual(legacyOrder[snapshot.run.id]);

    const comparable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => (key === 'sourceKind' || key === 'sortKey' ? undefined : entry))) as unknown;
    const same = (read: (store: PlanQueueStore) => unknown) => expect(comparable(read(after))).toEqual(comparable(read(old)));
    same(store => store.listRuns(100_000));
    same(store => store.listActiveRuns());
    same(store => store.listWorkspaceRoots());
    same(store => store.listRunsWithRelaxation());
    same(store => store.hasActiveWork());
    same(store => store.listItemsWithKeptFolders());
    same(store => store.listItemsWithGitOwnership());
    same(store => store.listPassedLandingParks());
    same(store => store.listAutomaticLandingsInEndedRuns());
    same(store => store.countAutomaticLandings());
    same(store => store.listFoldersWithDiscardedItems());
    same(store => store.queueHealth());
    const refs = [...new Set(after.listItemsWithGitOwnership().map(item => item.sourceRef))].slice(0, 300);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      same(store => store.latestAttempts(ref, 5));
      same(store => store.documentInPlay({ sourceRef: ref, id: 'none' }));
      same(store => store.documentBeingChecked(ref, 'none'));
    }
    for (const item of after.listItemsWithGitOwnership().slice(0, 300)) {
      same(store => store.newerAttemptLanded(item));
      same(store => store.newerAttemptCommits(item));
      same(store => store.getItem(item.id));
      same(store => store.lastParkedAt(item.id));
    }
    for (const folder of after.listWorkspaceRoots()) same(store => store.listParkedInFolder(folder));
  });
});
