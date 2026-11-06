import type { Migration } from './rlm-types';

export const CONNECTOR_STORAGE_SQL = `
  CREATE TABLE IF NOT EXISTS connector_auth (
    connector_id TEXT PRIMARY KEY REFERENCES orchestrator_mcp_servers(id) ON DELETE CASCADE,
    encrypted_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connector_migration_state (source_id TEXT PRIMARY KEY);
`;

export const RLM_MIGRATIONS_076_080: Migration[] = [
  {
    // A denied/failed browser decision's reason code used to reach only the
    // tool result: the audit row carried the prose summary alone, so the exact
    // failure step and cause (LT-703's `dispatch:credential_selector_outside_…`)
    // were not queryable from the forensic record at all.
    name: '076_browser_audit_reason',
    up: `
      ALTER TABLE browser_audit_entries ADD COLUMN reason TEXT;
    `,
    down: `
      ALTER TABLE browser_audit_entries DROP COLUMN reason;
    `,
  },
  {
    name: '077_a0_per_turn_cost_booking',
    up: `
      CREATE TABLE maintenance_markers (name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
      CREATE TABLE cost_entries_a0_backup AS SELECT * FROM cost_entries WHERE 0;
      CREATE UNIQUE INDEX idx_cost_entries_a0_backup_id ON cost_entries_a0_backup(id);
      CREATE TABLE cost_entry_model_usage (
        entry_id TEXT NOT NULL REFERENCES cost_entries(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        PRIMARY KEY (entry_id, model)
      );
      INSERT INTO maintenance_markers(name, completed_at)
        VALUES ('a0-per-turn-booking-live', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
    `,
    down: `
      DROP TABLE cost_entry_model_usage;
      DROP TABLE cost_entries_a0_backup;
      DROP TABLE maintenance_markers;
    `,
  },
  {
    // What the agent said it was asking for, apart from anything read off the
    // page. Kept in its own column (not inside element_context_json) so page
    // text and agent text cannot be confused, and so the duplicate-request check
    // that compares element context is unaffected. Old rows stay NULL.
    name: '078_browser_approval_request_reason',
    up: `
      ALTER TABLE browser_approval_requests ADD COLUMN request_reason TEXT;
    `,
    down: `
      ALTER TABLE browser_approval_requests DROP COLUMN request_reason;
    `,
  },
  {
    // Main and phase-1 migrations share numeric prefixes 078–080. They are
    // tracked by full name and may already be applied on real databases, so
    // preserve every name and SQL checksum from both branches.
    name: '078_wake_hint_tombstones',
    up: `
      CREATE TABLE wake_hint_tombstones (
        room TEXT NOT NULL,
        content_key TEXT NOT NULL,
        removed_at INTEGER NOT NULL,
        PRIMARY KEY (room, content_key)
      );
    `,
    down: `DROP TABLE wake_hint_tombstones;`,
  },
  {
    name: '078_automation_pre_check',
    up: `
      ALTER TABLE automation_runs ADD COLUMN outcome TEXT;
      CREATE TABLE automation_check_state (
        automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
        baseline_hash TEXT,
        baseline_output TEXT,
        baseline_at INTEGER,
        pending_run_id TEXT,
        pending_hash TEXT,
        pending_output TEXT,
        failure_streak INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP TABLE automation_check_state;
      ALTER TABLE automation_runs DROP COLUMN outcome;
    `,
  },
  {
    name: '079_automation_thread_prompt_delivery',
    up: `
      ALTER TABLE automation_runs ADD COLUMN thread_prompt_delivered INTEGER
        CHECK(thread_prompt_delivered IS NULL OR thread_prompt_delivered IN (0, 1));
    `,
    down: `
      ALTER TABLE automation_runs DROP COLUMN thread_prompt_delivered;
    `,
  },
  {
    name: '080_helper_budget_notice_day',
    up: `
      CREATE TABLE local_ai_helper_budget_notice (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        day TEXT NOT NULL
      );
    `,
    down: `DROP TABLE local_ai_helper_budget_notice;`,
  },
  {
    name: '079_global_pause_batches',
    up: `
      CREATE TABLE global_pause_batches (
        id TEXT PRIMARY KEY, phase TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, ready_at INTEGER, resumed_at INTEGER,
        discarded_at INTEGER, expired_at INTEGER
      );
      CREATE UNIQUE INDEX idx_global_pause_open ON global_pause_batches ((1))
        WHERE phase NOT IN ('resumed', 'discarded', 'expired');
      CREATE TABLE global_pause_entries (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES global_pause_batches(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, target_id TEXT NOT NULL, display_name TEXT NOT NULL,
        workspace TEXT, provider TEXT, original_instance_id TEXT,
        history_thread_id TEXT, provider_session_id TEXT,
        was_busy INTEGER NOT NULL DEFAULT 0, note_text TEXT,
        note_kind TEXT NOT NULL DEFAULT 'none', state TEXT NOT NULL DEFAULT 'pending',
        void_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(batch_id, kind, target_id)
      );
      CREATE INDEX idx_global_pause_entries_batch ON global_pause_entries(batch_id);
    `,
    down: `DROP TABLE global_pause_entries; DROP TABLE global_pause_batches;`,
  },
  {
    name: '080_connectors',
    up: `ALTER TABLE orchestrator_mcp_servers ADD COLUMN connector_json TEXT; ${CONNECTOR_STORAGE_SQL}`,
    down: `DROP TABLE connector_auth; DROP TABLE connector_migration_state; ALTER TABLE orchestrator_mcp_servers DROP COLUMN connector_json;`,
  },
];
