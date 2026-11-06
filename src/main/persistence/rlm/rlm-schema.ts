/**
 * RLM Schema Module
 *
 * Table creation SQL and migrations.
 * Note: This file uses better-sqlite3's db.exec() method for executing SQL,
 * not child_process.exec(). This is safe as it's database SQL execution.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import * as crypto from 'crypto';
import type { Migration } from './rlm-types';
import type { MigrationRow } from '../rlm-database.types';
import { ensureContextSectionSummaryColumns } from './rlm-schema-context-sections';
import { RLM_MIGRATIONS_001_015 } from './rlm-migrations-001-015';
import { RLM_MIGRATIONS_016_021 } from './rlm-migrations-016-021';
import { RLM_MIGRATIONS_022_035 } from './rlm-migrations-022-035';
import { RLM_MIGRATIONS_036_040 } from './rlm-migrations-036-040';
import { RLM_MIGRATIONS_041_045 } from './rlm-migrations-041-045';
import { RLM_MIGRATIONS_046_050 } from './rlm-migrations-046-050';
import { RLM_MIGRATIONS_051_055 } from './rlm-migrations-051-055';
import { RLM_MIGRATIONS_056_060 } from './rlm-migrations-056-060';
import { RLM_MIGRATIONS_061_065 } from './rlm-migrations-061-065';
import { RLM_MIGRATIONS_066_070 } from './rlm-migrations-066-070';
import { RLM_MIGRATIONS_071_075 } from './rlm-migrations-071-075';
import { RLM_MIGRATIONS_076_080 } from './rlm-migrations-076-080';
import { RLM_MIGRATIONS_081_085 } from './rlm-migrations-081-085';

/** Keep the persisted 083 migration name stable; 082 remains reserved. */
export const AUTOMATION_RUN_POLICY_MIGRATION: Migration = {
  name: '083_automation_run_policy',
  up: `
    UPDATE automations SET action_json = json_set(action_json,
      '$.maxRunMinutes', MAX(30, CAST(ceil(COALESCE((SELECT MAX((r.finished_at - r.started_at) / 60000.0) * 1.5
        FROM automation_runs r WHERE r.automation_id = automations.id AND r.status = 'succeeded'
          AND r.started_at IS NOT NULL AND r.finished_at >= r.started_at), 0)) AS INTEGER)))
      WHERE json_extract(action_json, '$.maxRunMinutes') IS NULL;
    UPDATE automations SET action_json = json_set(action_json, '$.maxProcessedTokens',
      CASE schedule_type WHEN 'oneTime' THEN 100000000 ELSE 30000000 END)
      WHERE json_extract(action_json, '$.maxProcessedTokens') IS NULL;
    CREATE TABLE automation_run_facts (
      run_id TEXT PRIMARY KEY REFERENCES automation_runs(id) ON DELETE CASCADE,
      result_json TEXT,
      processed_tokens INTEGER NOT NULL DEFAULT 0,
      delivery_started_at INTEGER,
      restart_retry_used INTEGER NOT NULL DEFAULT 0,
      restart_source_run_id TEXT
    );
    CREATE TABLE automation_run_usage (
      run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      instance_id TEXT NOT NULL,
      provider_tokens INTEGER NOT NULL DEFAULT 0,
      attributed_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(run_id, instance_id)
    );
    CREATE TABLE automation_monitor_state (
      automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
      fingerprint TEXT,
      unchanged_checks INTEGER NOT NULL DEFAULT 0,
      interval_multiplier INTEGER NOT NULL DEFAULT 1,
      quiet_runs INTEGER NOT NULL DEFAULT 0,
      model_hint_dismissed INTEGER NOT NULL DEFAULT 0
    );
  `,
  down: `DROP TABLE automation_monitor_state; DROP TABLE automation_run_usage; DROP TABLE automation_run_facts;`,
};

/**
 * Migrations to be applied in order
 */
export const MIGRATIONS: Migration[] = [
  ...RLM_MIGRATIONS_001_015,
  ...RLM_MIGRATIONS_016_021,
  ...RLM_MIGRATIONS_022_035,
  ...RLM_MIGRATIONS_036_040,
  ...RLM_MIGRATIONS_041_045,
  ...RLM_MIGRATIONS_046_050,
  ...RLM_MIGRATIONS_051_055,
  ...RLM_MIGRATIONS_056_060,
  ...RLM_MIGRATIONS_061_065,
  ...RLM_MIGRATIONS_066_070,
  ...RLM_MIGRATIONS_071_075,
  ...RLM_MIGRATIONS_076_080,
  ...RLM_MIGRATIONS_081_085,
  AUTOMATION_RUN_POLICY_MIGRATION,
];

/** Enable WAL when main and the context worker open a fresh database together. */
export function enableRlmWal(db: SqliteDriver): void {
  // SQLite can reject simultaneous journal-mode changes immediately without
  // invoking its busy handler. Own the wait here: leaving the native timeout
  // enabled can add another five seconds when the lock changes from writer to
  // reader during a retry. Restore it for normal queries and migrations.
  const busyTimeout = db.pragma('busy_timeout', { simple: true });
  db.pragma('busy_timeout = 0');
  const deadline = performance.now() + 5_000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  try {
    while (true) {
      try {
        db.pragma('journal_mode = WAL');
        return;
      } catch (error) {
        const remaining = deadline - performance.now();
        if (typeof error !== 'object' || error === null || !('code' in error)
            || error.code !== 'SQLITE_BUSY' || remaining <= 0) {
          throw error;
        }
        Atomics.wait(waitBuffer, 0, 0, Math.min(25, remaining));
        if (performance.now() >= deadline) throw error;
      }
    }
  } finally {
    db.pragma(`busy_timeout = ${busyTimeout}`);
  }
}

/**
 * Create all tables for the RLM database.
 * Uses better-sqlite3's exec method for SQL execution (not child_process).
 */
export function createTables(db: SqliteDriver): void {
  // Context Stores table
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_stores (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      total_tokens INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      access_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      config_json TEXT,
      UNIQUE(instance_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stores_instance
      ON context_stores(instance_id);
    CREATE INDEX IF NOT EXISTS idx_stores_accessed
      ON context_stores(last_accessed);
  `);

  // Context Sections table
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_sections (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      checksum TEXT,
      depth INTEGER DEFAULT 0,
      summarizes_json TEXT,
      parent_summary_id TEXT,
      pending_summary INTEGER DEFAULT 0,
      summary_priority INTEGER DEFAULT 0,
      last_summary_attempt INTEGER,
      file_path TEXT,
      language TEXT,
      source_url TEXT,
      created_at INTEGER NOT NULL,
      -- Marker meaning "this section's content lives on disk, not inline".
      -- NOT an address: nothing resolves content through this value. It records
      -- the absolute path at write time, so it can name a userData root that no
      -- longer exists after an app rename or profile migration. Reads, deletes,
      -- backups and maintenance all re-derive the path from the section id via
      -- resolveContentPath() in rlm-content.ts. Only its NULL-ness is load-bearing.
      content_file TEXT,
      content_inline TEXT,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sections_store
      ON context_sections(store_id);
    CREATE INDEX IF NOT EXISTS idx_sections_type
      ON context_sections(type);
    CREATE INDEX IF NOT EXISTS idx_sections_offset
      ON context_sections(store_id, start_offset);
    CREATE INDEX IF NOT EXISTS idx_sections_depth
      ON context_sections(store_id, depth);
  `);
  ensureContextSectionSummaryColumns(db);

  // RLM Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS rlm_sessions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      total_queries INTEGER DEFAULT 0,
      total_root_tokens INTEGER DEFAULT 0,
      total_sub_query_tokens INTEGER DEFAULT 0,
      estimated_direct_tokens INTEGER DEFAULT 0,
      token_savings_percent REAL DEFAULT 0,
      queries_json TEXT,
      recursive_calls_json TEXT,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_store
      ON rlm_sessions(store_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_instance
      ON rlm_sessions(instance_id);
  `);

  // Outcomes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      success INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER,
      token_usage INTEGER,
      agent_id TEXT,
      model TEXT,
      error_type TEXT,
      prompt_hash TEXT,
      tools_json TEXT,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_task
      ON outcomes(task_type);
    CREATE INDEX IF NOT EXISTS idx_outcomes_timestamp
      ON outcomes(timestamp);
    CREATE INDEX IF NOT EXISTS idx_outcomes_agent
      ON outcomes(agent_id);
  `);

  // Patterns table
  db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      effectiveness REAL NOT NULL,
      sample_size INTEGER NOT NULL,
      last_updated INTEGER NOT NULL,
      metadata_json TEXT,
      UNIQUE(type, key)
    );

    CREATE INDEX IF NOT EXISTS idx_patterns_type
      ON patterns(type);
    CREATE INDEX IF NOT EXISTS idx_patterns_effectiveness
      ON patterns(effectiveness);
  `);

  // Experiences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL UNIQUE,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      success_patterns_json TEXT,
      failure_patterns_json TEXT,
      example_prompts_json TEXT,
      last_updated INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_experiences_task
      ON experiences(task_type);
  `);

  // Insights table
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      confidence REAL NOT NULL,
      supporting_patterns_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_insights_type
      ON insights(type);
    CREATE INDEX IF NOT EXISTS idx_insights_confidence
      ON insights(confidence);
  `);

  // Vectors table (for semantic search)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      content_preview TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES context_sections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vectors_store
      ON vectors(store_id);
    CREATE INDEX IF NOT EXISTS idx_vectors_section
      ON vectors(section_id);
  `);
}

/**
 * Create the migrations tracking table.
 */
export function createMigrationsTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_migrations_name ON _migrations(name);
  `);
}

/**
 * Compute checksum for a migration.
 */
export function computeMigrationChecksum(migration: Migration): string {
  return crypto.createHash('sha256').update(migration.up).digest('hex').substring(0, 16);
}

/**
 * Get all applied migrations.
 */
export function getAppliedMigrations(db: SqliteDriver): MigrationRow[] {
  const stmt = db.prepare(`SELECT * FROM _migrations ORDER BY id ASC`);
  return stmt.all() as MigrationRow[];
}

/**
 * Run pending migrations.
 *
 * @param db - Database instance
 * @param onMigrationApplied - Callback when a migration is applied
 * @param onMigrationsComplete - Callback when all migrations are complete
 */
export function runMigrations(
  db: SqliteDriver,
  onMigrationApplied?: (name: string) => void,
  onMigrationsComplete?: (applied: number) => void
): void {
  // Main and the context worker can initialize the same fresh profile together.
  // Acquire the writer lock before reading migration state so a waiting startup
  // sees the other startup's committed migrations rather than a stale snapshot.
  db.exec('BEGIN IMMEDIATE');
  let appliedCount = 0;
  try {
    const appliedMigrations = getAppliedMigrations(db);
    const appliedNames = new Set(appliedMigrations.map(m => m.name));

    // Verify checksums of applied migrations haven't changed
    for (const applied of appliedMigrations) {
      const migration = MIGRATIONS.find(m => m.name === applied.name);
      if (migration) {
        const expectedChecksum = computeMigrationChecksum(migration);
        if (applied.checksum !== expectedChecksum) {
          throw new Error(
            `Migration checksum mismatch for "${applied.name}". ` +
            `Expected ${expectedChecksum}, got ${applied.checksum}. ` +
            `Migration files should not be modified after being applied.`
          );
        }
      }
    }

    const pendingMigrations = MIGRATIONS.filter(m => !appliedNames.has(m.name));

    for (const migration of pendingMigrations) {
      try {
        db.exec(migration.up);

        const checksum = computeMigrationChecksum(migration);
        const insertStmt = db.prepare(`
          INSERT INTO _migrations (name, applied_at, checksum)
          VALUES (?, ?, ?)
        `);
        insertStmt.run(migration.name, Date.now(), checksum);

        onMigrationApplied?.(migration.name);
      } catch (error) {
        throw new Error(
          `Failed to apply migration "${migration.name}": ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    appliedCount = pendingMigrations.length;
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      // SQLite may already have rolled back (for example on SQLITE_FULL).
      // Keep both failures so rollback cannot hide the migration diagnosis.
      throw new AggregateError([error, rollbackError],
        `${error instanceof Error ? error.message : String(error)}; ` +
        `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error });
    }
    throw error;
  }

  if (appliedCount > 0) onMigrationsComplete?.(appliedCount);
}

/**
 * Get schema information.
 */
export function getSchemaInfo(
  db: SqliteDriver,
  schemaVersion: number
): {
  version: number;
  appliedMigrations: MigrationRow[];
  pendingMigrations: string[];
} {
  const applied = getAppliedMigrations(db);
  const appliedNames = new Set(applied.map(m => m.name));
  const pending = MIGRATIONS
    .filter(m => !appliedNames.has(m.name))
    .map(m => m.name);

  return {
    version: schemaVersion,
    appliedMigrations: applied,
    pendingMigrations: pending,
  };
}
