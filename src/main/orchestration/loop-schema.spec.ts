/**
 * P3 acceptance: the worktree-columns migration (v9) must apply cleanly on a
 * pre-v9 database. Existing `loop_runs` rows must survive with NULL
 * worktree_path / branch_name (no data loss), and re-running migrations must be
 * idempotent.
 *
 * We reconstruct a genuine "old app" schema with `runLoopMigrationsUpTo(db, 8)`
 * (the real historical migration SQL, capped at v8) rather than hand-writing a
 * stale DDL — so the test cannot drift from the actual v1–v8 schema.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  LOOP_SCHEMA_VERSION,
  runLoopMigrations,
  runLoopMigrationsUpTo,
} from './loop-schema';

let driver: SqliteDriver;

beforeEach(() => {
  driver = new Database(':memory:') as unknown as SqliteDriver;
});

afterEach(() => {
  driver.close();
});

function columnNames(table: string): string[] {
  return driver
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .map((r) => r.name);
}

function appliedVersions(): number[] {
  return driver
    .prepare('SELECT version FROM loop_migrations ORDER BY version')
    .all<{ version: number }>()
    .map((r) => r.version);
}

describe('loop-schema v9 worktree-columns migration', () => {
  it('upgrades a pre-v9 database without data loss; new columns are NULL on legacy rows', () => {
    // 1. Old app: only migrations up to v8 applied — no worktree columns yet.
    runLoopMigrationsUpTo(driver, 8);
    expect(appliedVersions()).not.toContain(9);
    expect(columnNames('loop_runs')).not.toContain('worktree_path');
    expect(columnNames('loop_runs')).not.toContain('branch_name');

    // 2. A legacy run written by the old app.
    driver
      .prepare(
        `INSERT INTO loop_runs (id, chat_id, config_json, status, started_at, total_iterations)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('legacy-run-1', 'chat-legacy', '{"workspaceCwd":"/old/project"}', 'completed', 1_700_000_000_000, 7);

    // 3. New app boots → full migrations run, adding all newer columns.
    runLoopMigrations(driver);

    // 4. The migration was recorded and the columns now exist.
    expect(appliedVersions()).toContain(9);
    expect(columnNames('loop_runs')).toContain('worktree_path');
    expect(columnNames('loop_runs')).toContain('branch_name');

    // 5. No data loss: the legacy row is intact and its new columns are NULL.
    const row = driver
      .prepare(
        `SELECT id, chat_id, status, total_iterations, worktree_path, branch_name
         FROM loop_runs WHERE id = 'legacy-run-1'`,
      )
      .get<{
        id: string;
        chat_id: string;
        status: string;
        total_iterations: number;
        worktree_path: string | null;
        branch_name: string | null;
      }>();
    expect(row).toBeTruthy();
    expect(row?.chat_id).toBe('chat-legacy');
    expect(row?.status).toBe('completed');
    expect(row?.total_iterations).toBe(7);
    expect(row?.worktree_path).toBeNull();
    expect(row?.branch_name).toBeNull();
  });

  it('a fresh database migrates straight to the current version with worktree columns present', () => {
    runLoopMigrations(driver);
    expect(appliedVersions()).toContain(9);
    expect(appliedVersions()).toContain(LOOP_SCHEMA_VERSION);
    expect(columnNames('loop_runs')).toEqual(
      expect.arrayContaining(['worktree_path', 'branch_name']),
    );
    expect(appliedVersions()).toContain(11);
    expect(columnNames('loop_outstanding_items')).toEqual(
      expect.arrayContaining(['recommended_answer']),
    );
    expect(appliedVersions()).toContain(12);
    expect(columnNames('loop_iterations')).toEqual(
      expect.arrayContaining(['final_audit_json']),
    );
    expect(appliedVersions()).toContain(13);
    expect(columnNames('loop_iterations')).toEqual(
      expect.arrayContaining(['verify_failure_kind']),
    );
    expect(appliedVersions()).toContain(14);
    expect(columnNames('loop_terminal_intents')).toEqual(
      expect.arrayContaining(['resume_at']),
    );
    expect(appliedVersions()).toContain(15);
    expect(columnNames('loop_iterations')).toEqual(
      expect.arrayContaining(['cache_read_tokens', 'cache_write_tokens', 'model', 'cost_known']),
    );
  });

  it('re-running migrations is idempotent (no duplicate-application, no error)', () => {
    runLoopMigrations(driver);
    const firstPass = appliedVersions();
    // Second boot — must be a no-op, not a "duplicate column" failure.
    expect(() => runLoopMigrations(driver)).not.toThrow();
    expect(appliedVersions()).toEqual(firstPass);
  });
});

describe('loop-schema v15 iteration cache/cost columns', () => {
  it('upgrades a pre-v15 database; legacy iterations keep their data and get NULL cache columns', () => {
    // 1. Old app: migrations up to v14, so no cache split is recorded at all.
    runLoopMigrationsUpTo(driver, 14);
    expect(columnNames('loop_iterations')).not.toContain('cache_read_tokens');
    expect(columnNames('loop_iterations')).not.toContain('cost_known');

    driver
      .prepare(
        `INSERT INTO loop_runs (id, chat_id, config_json, status, started_at, total_iterations)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('run-v14', 'chat-v14', '{"workspaceCwd":"/p"}', 'completed', 1_700_000_000_000, 1);

    // A legacy iteration priced by the old flat $15/Mtok estimator.
    driver
      .prepare(
        `INSERT INTO loop_iterations
           (id, loop_run_id, seq, stage, started_at, tokens, cost_cents, work_hash,
            progress_verdict, verify_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('iter-v14', 'run-v14', 0, 'IMPLEMENT', 1_700_000_000_000, 1_000_000, 1500, 'wh', 'OK', 'not-run');

    // 2. New app boots.
    runLoopMigrations(driver);
    expect(appliedVersions()).toContain(15);

    // 3. The legacy row survives, and its new columns are NULL — NOT zero. An
    //    audit must be able to tell "we never recorded a cache split" apart
    //    from "this iteration genuinely used no cache".
    const row = driver
      .prepare(
        `SELECT tokens, cost_cents, cache_read_tokens, cache_write_tokens, model, cost_known
         FROM loop_iterations WHERE id = 'iter-v14'`,
      )
      .get<{
        tokens: number;
        cost_cents: number;
        cache_read_tokens: number | null;
        cache_write_tokens: number | null;
        model: string | null;
        cost_known: number | null;
      }>();

    expect(row?.tokens).toBe(1_000_000);
    expect(row?.cost_cents).toBe(1500);
    expect(row?.cache_read_tokens).toBeNull();
    expect(row?.cache_write_tokens).toBeNull();
    expect(row?.model).toBeNull();
    expect(row?.cost_known).toBeNull();
  });
});
