import type { Migration } from './rlm-types';

/**
 * Rebuild `automation_runs` so its status CHECK accepts `'needs-attention'`:
 * a loop-owned pause ends its automation run (so the schedule is freed) while
 * staying distinct from a failure — `recordRunOutcome` deliberately does not
 * count it towards the auto-disable streak. Data is preserved verbatim,
 * including the run facts and usage rows that cascade from `automation_runs`
 * (copied aside first because dropping the table deletes them).
 *
 * `down` rebuilds the narrower CHECK and folds any `'needs-attention'` rows
 * back to `'failed'`, so rollback never violates the old constraint.
 */
const REBUILD_COLUMNS = `id, automation_id, status, trigger, scheduled_at, started_at, finished_at,
        instance_id, error, output_summary, output_full_ref, idempotency_key,
        trigger_source_json, delivery_mode, seen_at, config_snapshot_json,
        created_at, updated_at, attempt, max_attempts,
        next_retry_at, next_retry_attempt, next_retry_max_attempts, loop_run_id,
        outcome, thread_prompt_delivered`;

const REBUILD_INDEXES = `
      CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_status
        ON automation_runs(automation_id, status);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_instance
        ON automation_runs(instance_id);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_scheduled
        ON automation_runs(automation_id, scheduled_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_schedule_dedupe
        ON automation_runs(automation_id, scheduled_at)
        WHERE trigger IN ('scheduled', 'catchUp');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_external_idempotency
        ON automation_runs(automation_id, trigger, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
`;

function rebuild(statusCheck: string, selectStatus: string): string {
  return `
      CREATE TEMP TABLE automation_run_facts_keep AS SELECT * FROM automation_run_facts;
      CREATE TEMP TABLE automation_run_usage_keep AS SELECT * FROM automation_run_usage;

      CREATE TABLE automation_runs_rebuild (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        status TEXT NOT NULL ${statusCheck},
        trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'catchUp', 'manual', 'webhook', 'channel', 'providerRuntime', 'orchestrationEvent')),
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        instance_id TEXT,
        error TEXT,
        output_summary TEXT,
        output_full_ref TEXT,
        idempotency_key TEXT,
        trigger_source_json TEXT,
        delivery_mode TEXT NOT NULL DEFAULT 'notify',
        seen_at INTEGER,
        config_snapshot_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        next_retry_at INTEGER,
        next_retry_attempt INTEGER,
        next_retry_max_attempts INTEGER,
        loop_run_id TEXT,
        outcome TEXT,
        thread_prompt_delivered INTEGER
          CHECK(thread_prompt_delivered IS NULL OR thread_prompt_delivered IN (0, 1)),
        FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
      );

      INSERT INTO automation_runs_rebuild (${REBUILD_COLUMNS})
      SELECT ${REBUILD_COLUMNS.replace('status,', selectStatus)}
      FROM automation_runs;

      DROP TABLE automation_runs;
      ALTER TABLE automation_runs_rebuild RENAME TO automation_runs;
      ${REBUILD_INDEXES}
      INSERT OR IGNORE INTO automation_run_facts SELECT * FROM automation_run_facts_keep;
      INSERT OR IGNORE INTO automation_run_usage SELECT * FROM automation_run_usage_keep;
      DROP TABLE automation_run_facts_keep;
      DROP TABLE automation_run_usage_keep;
  `;
}

/**
 * Registered after `083_automation_run_policy` (which creates the cascading
 * fact and usage tables) and before the credit migration, which stays last.
 */
export const AUTOMATION_RUN_NEEDS_ATTENTION_MIGRATION: Migration = {
  name: '083_automation_run_needs_attention_status',
  up: rebuild(
    `CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'needs-attention'))`,
    'status,',
  ),
  down: rebuild(
    `CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'))`,
    `CASE WHEN status = 'needs-attention' THEN 'failed' ELSE status END AS status,`,
  ),
};

export const RLM_MIGRATIONS_081_085: Migration[] = [
  // These migrations came from separate branches and may already be applied. The
  // ledger keys by full name, so preserve both names and SQL checksums.
  {
    name: '081_browser_audit_command_id',
    up: `
      ALTER TABLE browser_audit_entries ADD COLUMN command_id TEXT;
      CREATE INDEX idx_browser_audit_command ON browser_audit_entries(command_id);
    `,
    down: `
      DROP INDEX idx_browser_audit_command;
      ALTER TABLE browser_audit_entries DROP COLUMN command_id;
    `,
  },
  {
    name: '081_browser_login_portal_accounts',
    // The old row may already contain another portal's overwritten account.
    // Keep it for inspection, but NULL portal_path requires live re-recording.
    // Move into a separate table and empty the old one within runMigrations'
    // transaction, so older app builds cannot read a random modern portal row.
    up: `
      CREATE TABLE IF NOT EXISTS browser_login_portal_recipes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('profile', 'node')),
        origin TEXT NOT NULL,
        portal_path TEXT,
        account_ref TEXT NOT NULL,
        login_url TEXT NOT NULL,
        logged_in_markers_json TEXT NOT NULL,
        relogin_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_outcome TEXT,
        last_outcome_reason TEXT,
        last_outcome_at INTEGER,
        UNIQUE(scope, origin, portal_path, account_ref)
      );
      INSERT INTO browser_login_portal_recipes
        (id, scope, scope_kind, origin, portal_path, account_ref, login_url,
         logged_in_markers_json, relogin_json, created_at, updated_at,
         last_outcome, last_outcome_reason, last_outcome_at)
        SELECT 'legacy-' || lower(hex(randomblob(16))), scope, scope_kind, origin, NULL, '',
          login_url, logged_in_markers_json, relogin_json, created_at, updated_at,
          last_outcome, last_outcome_reason, last_outcome_at FROM browser_login_recipes;
      DELETE FROM browser_login_recipes;
    `,
    // Retain modern recipes in their own table, invisible to older builds.
    // Never repopulate the old origin-wide store on downgrade: it could choose
    // another buyer's account. Repeated down/up retains all modern data.
    down: `SELECT 1;`,
  },
  {
    // A#185: existing rows have no recorded origin; do not invent one.
    name: '082_cost_entry_origin',
    up: `ALTER TABLE cost_entries ADD COLUMN origin TEXT;`,
    down: `ALTER TABLE cost_entries DROP COLUMN origin;`,
  },
  {
    name: '083_browser_device_login_approvals',
    up: `
      ALTER TABLE browser_approval_requests ADD COLUMN device_login_json TEXT;
      CREATE UNIQUE INDEX idx_browser_device_login_operation ON browser_approval_requests(
        json_extract(device_login_json, '$.operationHandle'),
        json_extract(device_login_json, '$.ownerSessionId'),
        json_extract(device_login_json, '$.ownerGeneration')
      ) WHERE device_login_json IS NOT NULL;
    `,
    down: `
      DROP INDEX idx_browser_device_login_operation;
      ALTER TABLE browser_approval_requests DROP COLUMN device_login_json;
    `,
  },
  {
    // One approval per Harness secret-protection recovery operation, and what
    // Harness did after it was approved (never page content).
    name: '083_browser_secret_recovery_approvals',
    up: `
      ALTER TABLE browser_approval_requests ADD COLUMN secret_recovery_json TEXT;
      ALTER TABLE browser_approval_requests ADD COLUMN secret_recovery_progress_json TEXT;
      CREATE UNIQUE INDEX idx_browser_secret_recovery_operation ON browser_approval_requests(
        json_extract(secret_recovery_json, '$.operationId')
      ) WHERE secret_recovery_json IS NOT NULL;
    `,
    down: `
      DROP INDEX idx_browser_secret_recovery_operation;
      ALTER TABLE browser_approval_requests DROP COLUMN secret_recovery_progress_json;
      ALTER TABLE browser_approval_requests DROP COLUMN secret_recovery_json;
    `,
  },
];
