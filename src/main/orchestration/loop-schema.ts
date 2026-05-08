/**
 * Loop Mode SQLite Schema + Migrations
 *
 * Two tables: `loop_runs` (one row per loop) and `loop_iterations` (one row
 * per iteration). The migration runner pattern matches
 * `conversation-ledger-schema.ts` so that ops folks have one mental model.
 */

import type { SqliteDriver } from '../db/sqlite-driver';

export const LOOP_SCHEMA_VERSION = 1;

interface LoopMigration {
  version: number;
  name: string;
  up: string;
}

const MIGRATIONS: LoopMigration[] = [
  {
    version: 1,
    name: '001_initial_loop_runs',
    up: `
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        plan_file TEXT,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        total_iterations INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_cents INTEGER NOT NULL DEFAULT 0,
        current_stage TEXT,
        completed_file_rename_observed INTEGER NOT NULL DEFAULT 0,
        highest_test_pass_count INTEGER NOT NULL DEFAULT 0,
        end_reason TEXT,
        end_evidence_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_loop_runs_chat
        ON loop_runs(chat_id, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_loop_runs_status
        ON loop_runs(status, started_at DESC);

      CREATE TABLE IF NOT EXISTS loop_iterations (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        stage TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        child_instance_id TEXT,
        tokens INTEGER NOT NULL DEFAULT 0,
        cost_cents INTEGER NOT NULL DEFAULT 0,
        files_changed_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]',
        test_pass_count INTEGER,
        test_fail_count INTEGER,
        work_hash TEXT NOT NULL,
        output_similarity_to_prev REAL,
        output_excerpt TEXT NOT NULL DEFAULT '',
        progress_verdict TEXT NOT NULL,
        progress_signals_json TEXT NOT NULL DEFAULT '[]',
        completion_signals_fired_json TEXT NOT NULL DEFAULT '[]',
        verify_status TEXT NOT NULL,
        verify_output_excerpt TEXT NOT NULL DEFAULT ''
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_iterations_run_seq
        ON loop_iterations(loop_run_id, seq);

      CREATE INDEX IF NOT EXISTS idx_loop_iterations_run_started
        ON loop_iterations(loop_run_id, started_at DESC);
    `,
  },
];

export function createLoopMigrationsTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function runLoopMigrations(db: SqliteDriver): void {
  createLoopMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT version FROM loop_migrations')
      .all<{ version: number }>()
      .map((r) => r.version),
  );

  const run = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      db.exec(m.up);
      db.prepare(`
        INSERT INTO loop_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(m.version, m.name, Date.now());
    }
  });

  run();
}
