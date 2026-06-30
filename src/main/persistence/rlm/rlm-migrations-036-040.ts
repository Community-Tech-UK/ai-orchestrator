import type { Migration } from './rlm-types';

/**
 * RLM migrations 036–040.
 *
 * Continuation bucket after the 022–035 range. Keep each migration idempotent
 * (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) — they are applied
 * by name and must be safe to re-run.
 */
export const RLM_MIGRATIONS_036_040: Migration[] = [
  // Migration 036: Persist cost entries so cost/budget history survives restarts.
  // Mirrors the token_stats table (migration 005); the CostTracker writes through
  // here on every recorded turn and rehydrates its in-memory window on startup.
  {
    name: '036_add_cost_entries_table',
    up: `
      CREATE TABLE IF NOT EXISTS cost_entries (
        id                 TEXT PRIMARY KEY,
        timestamp          INTEGER NOT NULL,
        instance_id        TEXT NOT NULL,
        session_id         TEXT NOT NULL,
        model              TEXT NOT NULL,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost               REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_cost_entries_time ON cost_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cost_entries_session ON cost_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_cost_entries_instance ON cost_entries(instance_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_cost_entries_instance;
      DROP INDEX IF EXISTS idx_cost_entries_session;
      DROP INDEX IF EXISTS idx_cost_entries_time;
      DROP TABLE IF EXISTS cost_entries;
    `,
  },
  {
    name: '037_add_cost_entry_reasoning_tokens',
    up: `
      ALTER TABLE cost_entries ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
    `,
    down: `
      -- SQLite cannot drop columns portably on older runtimes; leave the
      -- additive analytics column in place on rollback.
    `,
  },
  {
    // Bind a browser profile to a remote worker node (Path 2). NULL = local.
    name: '038_browser_profile_execution_node',
    up: `
      ALTER TABLE browser_profiles ADD COLUMN execution_node_id TEXT;
    `,
    down: `
      -- SQLite cannot drop columns portably on older runtimes; leave the
      -- additive column in place on rollback.
    `,
  },
  {
    name: '039_add_session_compaction_markers',
    up: `
      CREATE TABLE IF NOT EXISTS session_compaction_markers (
        id                   TEXT PRIMARY KEY,
        instance_id          TEXT NOT NULL,
        thread_id            TEXT,
        project_key          TEXT,
        method               TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        utilization_before   REAL,
        utilization_after    REAL,
        ledger_anchor        INTEGER NOT NULL,
        metadata_json        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_compaction_markers_instance
        ON session_compaction_markers(instance_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_compaction_markers_project
        ON session_compaction_markers(project_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_compaction_markers_created
        ON session_compaction_markers(created_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_compaction_markers_created;
      DROP INDEX IF EXISTS idx_compaction_markers_project;
      DROP INDEX IF EXISTS idx_compaction_markers_instance;
      DROP TABLE IF EXISTS session_compaction_markers;
    `,
  },
];
