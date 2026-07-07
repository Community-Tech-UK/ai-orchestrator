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
  // Migration 040: unattended browser-automation persistence — credential vault
  // origin bindings, standing credential authorizations, campaigns + budget
  // counters, and the human-escalation queue. Secrets stay in Bitwarden; these
  // tables hold only references, scopes, budgets and status.
  {
    name: '040_browser_unattended_tables',
    up: `
      CREATE TABLE IF NOT EXISTS browser_vault_item_bindings (
        vault_item_ref   TEXT PRIMARY KEY,
        origin           TEXT NOT NULL,
        username         TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_credential_authorizations (
        id                   TEXT PRIMARY KEY,
        profile_id           TEXT NOT NULL,
        allowed_origins_json TEXT NOT NULL,
        purposes_json        TEXT NOT NULL,
        vault_folder         TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        expires_at           INTEGER NOT NULL,
        revoked_at           INTEGER,
        note                 TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cred_auth_profile
        ON browser_credential_authorizations(profile_id);

      CREATE TABLE IF NOT EXISTS browser_campaigns (
        id                               TEXT PRIMARY KEY,
        label                            TEXT NOT NULL,
        profile_id                       TEXT NOT NULL,
        allowed_origins_json             TEXT NOT NULL,
        allowed_action_classes_json      TEXT NOT NULL,
        budget_json                      TEXT NOT NULL,
        approved_declaration_hashes_json TEXT NOT NULL,
        status                           TEXT NOT NULL,
        created_at                       INTEGER NOT NULL,
        expires_at                       INTEGER NOT NULL,
        approved_by                      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaigns_status
        ON browser_campaigns(status);

      CREATE TABLE IF NOT EXISTS browser_campaign_counters (
        campaign_id      TEXT PRIMARY KEY,
        actions          INTEGER NOT NULL DEFAULT 0,
        submits          INTEGER NOT NULL DEFAULT 0,
        new_accounts     INTEGER NOT NULL DEFAULT 0,
        uploads          INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS browser_escalations (
        id                     TEXT PRIMARY KEY,
        campaign_id            TEXT,
        profile_id             TEXT NOT NULL,
        target_id              TEXT,
        kind                   TEXT NOT NULL,
        reason                 TEXT NOT NULL,
        url                    TEXT,
        screenshot_artifact_id TEXT,
        status                 TEXT NOT NULL,
        created_at             INTEGER NOT NULL,
        resolved_at            INTEGER,
        resolution_note        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_escalations_status
        ON browser_escalations(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_escalations_campaign
        ON browser_escalations(campaign_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_escalations_campaign;
      DROP INDEX IF EXISTS idx_escalations_status;
      DROP TABLE IF EXISTS browser_escalations;
      DROP TABLE IF EXISTS browser_campaign_counters;
      DROP INDEX IF EXISTS idx_campaigns_status;
      DROP TABLE IF EXISTS browser_campaigns;
      DROP INDEX IF EXISTS idx_cred_auth_profile;
      DROP TABLE IF EXISTS browser_credential_authorizations;
      DROP TABLE IF EXISTS browser_vault_item_bindings;
    `,
  },
];
