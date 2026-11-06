import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { AutomationCheckStore, CHECK_OUTPUT_MAX_CHARS } from './automation-check-store';
import type { AutomationRun } from '../../shared/types/automation.types';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('AutomationCheckStore (A15 / 8b)', () => {
  let db: SqliteDriver;
  let store: AutomationCheckStore;

  beforeEach(() => {
    db = createDb();
    store = new AutomationCheckStore(db);
    db.prepare(`
      INSERT INTO automations
        (id, name, enabled, active, workspace_id, schedule_type, schedule_json, trigger_json,
         missed_run_policy, concurrency_policy, action_json, created_at, updated_at)
      VALUES ('a1', 'Checked job', 1, 1, '/tmp', 'cron', '{}', '{}', 'notify', 'skip', '{}', 1, 1)
    `).run();
    for (const [id, scheduledAt] of [['r1', 1], ['r2', 2]] as const) {
      db.prepare(`
        INSERT INTO automation_runs
          (id, automation_id, status, trigger, scheduled_at, config_snapshot_json, attempt, max_attempts, created_at, updated_at)
        VALUES (?, 'a1', 'running', 'scheduled', ?, ?, 1, 3, 1, 1)
      `).run(id, scheduledAt, JSON.stringify({ action: { prompt: 'orig', workingDirectory: '/tmp' } }));
    }
  });

  afterEach(() => {
    db.close();
  });

  it('promotes the pending capture only for the matching run', () => {
    store.setPending('a1', 'r1', 'hash-1', 'output-1');

    expect(store.promotePending('r2')).toBe(false);
    let state = store.getState('a1');
    expect(state?.pendingRunId).toBe('r1');
    expect(state?.baselineHash).toBeNull();

    expect(store.promotePending('r1')).toBe(true);
    state = store.getState('a1');
    expect(state?.baselineHash).toBe('hash-1');
    expect(state?.baselineOutput).toBe('output-1');
    expect(state?.pendingRunId).toBeNull();
    expect(state?.pendingHash).toBeNull();
  });

  it('clears the pending capture for the matching run only', () => {
    store.setPending('a1', 'r1', 'hash-1', 'output-1');
    store.clearPending('r2');
    expect(store.getState('a1')?.pendingRunId).toBe('r1');
    store.clearPending('r1');
    expect(store.getState('a1')?.pendingRunId).toBeNull();
  });

  it('grows and clears the check-failure streak', () => {
    expect(store.recordCheckFailure('a1')).toBe(1);
    expect(store.recordCheckFailure('a1')).toBe(2);
    expect(store.clearCheckFailure('a1')).toBe(0);
    expect(store.getState('a1')?.failureStreak).toBe(0);
  });

  it('truncates stored output to 16 KB', () => {
    const big = 'x'.repeat(CHECK_OUTPUT_MAX_CHARS + 100);
    store.setPending('a1', 'r1', 'hash', big);
    expect(store.getState('a1')?.pendingOutput?.length).toBe(CHECK_OUTPUT_MAX_CHARS);
  });

  it('records run outcomes and rewrites the snapshot prompt for retries', () => {
    store.setRunOutcome('r1', 'changed');
    store.setRunPrompt('r1', 'orig\n\n<automation_check_result>…</automation_check_result>');

    const row = db.prepare(`
      SELECT outcome, config_snapshot_json FROM automation_runs WHERE id = 'r1'
    `).get<{ outcome: string; config_snapshot_json: string }>();
    expect(row?.outcome).toBe('changed');
    expect(JSON.parse(row!.config_snapshot_json).action.prompt).toContain('automation_check_result');
    expect(JSON.parse(row!.config_snapshot_json).action.workingDirectory).toBe('/tmp');
  });

  it('cascades the check state when the automation is deleted', () => {
    store.setPending('a1', 'r1', 'hash-1', 'output-1');
    db.prepare(`DELETE FROM automations WHERE id = 'a1'`).run();
    expect(store.getState('a1')).toBeNull();
    const remaining = db.prepare(`
      SELECT COUNT(*) AS n FROM automation_check_state
    `).get<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('keeps automation_runs rows typed for the outcome map', () => {
    // Sanity: the run rows this store updates map back through mapRunRow.
    const mapped: AutomationRun['outcome'] = 'check-failed';
    store.setRunOutcome('r2', mapped);
    const row = db.prepare(`SELECT outcome FROM automation_runs WHERE id = 'r2'`).get<{ outcome: string }>();
    expect(row?.outcome).toBe('check-failed');
  });
});
