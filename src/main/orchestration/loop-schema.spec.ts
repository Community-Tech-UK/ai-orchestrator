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

    // 3. New app boots → full migrations run, adding v9 (worktree cols) + v10.
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
  });

  it('re-running migrations is idempotent (no duplicate-application, no error)', () => {
    runLoopMigrations(driver);
    const firstPass = appliedVersions();
    // Second boot — must be a no-op, not a "duplicate column" failure.
    expect(() => runLoopMigrations(driver)).not.toThrow();
    expect(appliedVersions()).toEqual(firstPass);
  });
});
