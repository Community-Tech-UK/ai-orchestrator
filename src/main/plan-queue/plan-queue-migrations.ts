/** Queue migrations follow the last schema version already present on this checkout. */
export const PLAN_QUEUE_MIGRATIONS = [
  { version: 31, name: '031_plan_queue_history', up: `
    CREATE TABLE plan_queue_item_events (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES plan_queue_items(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, at INTEGER NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
      reason TEXT, detail_head TEXT, round INTEGER NOT NULL, tokens INTEGER NOT NULL
    );
    CREATE INDEX idx_queue_events_item ON plan_queue_item_events(item_id, at);
    CREATE TABLE plan_queue_verdicts (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES plan_queue_items(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, round INTEGER NOT NULL, at INTEGER NOT NULL, verdict TEXT NOT NULL,
      findings_json TEXT NOT NULL, gates_json TEXT NOT NULL, not_checked_json TEXT NOT NULL,
      worktree_head TEXT, document_sha256 TEXT
    );
    CREATE INDEX idx_queue_verdicts_item ON plan_queue_verdicts(item_id, at);
    CREATE INDEX idx_queue_parked_doc ON plan_queue_items(document_path, state, updated_at DESC);
    CREATE TABLE plan_queue_item_pins (
      item_id TEXT PRIMARY KEY REFERENCES plan_queue_items(id) ON DELETE CASCADE,
      document_sha256 TEXT NOT NULL, document_bytes INTEGER NOT NULL,
      unchecked_json TEXT NOT NULL, recorded_at INTEGER NOT NULL
    );
    CREATE TABLE plan_queue_triage_decisions (
      document_sha256 TEXT PRIMARY KEY, decision_json TEXT NOT NULL, decided_at INTEGER NOT NULL
    );
  ` },
  { version: 32, name: '032_plan_queue_spend', up: `
    CREATE TABLE plan_queue_spend (
      id TEXT PRIMARY KEY, item_id TEXT REFERENCES plan_queue_items(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES plan_queue_runs(id) ON DELETE CASCADE,
      role TEXT NOT NULL, round INTEGER, provider TEXT, model TEXT,
      processed INTEGER NOT NULL, output INTEGER NOT NULL, cost_usd REAL,
      cost_basis TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queue_spend_run ON plan_queue_spend(run_id, created_at);
    ALTER TABLE plan_queue_items ADD COLUMN unpriced_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE plan_queue_runs ADD COLUMN unpriced_tokens INTEGER NOT NULL DEFAULT 0;
    UPDATE plan_queue_items SET unpriced_tokens = tokens WHERE cost_usd = 0 AND tokens > 0;
    UPDATE plan_queue_runs SET unpriced_tokens = tokens WHERE cost_usd = 0 AND tokens > 0;
  ` },
];

/**
 * Versions held for the Plan Queue autonomy-and-Linear programme (2026-11-03-plan-queue-autonomy-and-linear_plan.md,
 * "Migrations this programme adds"). Versions 40-42 are already taken (livetest port, base conflicts and the
 * legacy-history repair), so the programme starts at 43. When one of these lands, it must use exactly the
 * version and name listed here; a migration that needs a different shape takes the next free number after
 * the last entry and amends this list in the same change. Nothing else may use a number in this block.
 */
export const PLAN_QUEUE_RESERVED_MIGRATIONS = [
  { version: 43, name: '043_plan_queue_item_worker_report', purpose: 'worker_report_json (step 5.1)' },
  { version: 44, name: '044_plan_queue_item_source_sort', purpose: 'source_kind and sort_key (step 6.2)' },
  { version: 45, name: '045_plan_queue_item_landing_wait', purpose: 'landing_wait_since and landing_wait_paths (step 4.2)' },
  { version: 46, name: '046_plan_queue_item_planning_file_hashes', purpose: 'moved planning-file hashes per path, as JSON (step 1.1)' },
  { version: 47, name: '047_plan_queue_item_worker_retry_backoff', purpose: 'persisted worker-retry backoff expiry (step 1.4), unless the restart counter covers it' },
  { version: 48, name: '048_plan_queue_item_linear_ticket', purpose: 'Linear item columns (ticket, approved brief, held change, criteria snapshot, claimed_at, cursors, last status written)' },
  { version: 49, name: '049_plan_queue_linear_tables', purpose: 'plan_queue_source_outbox and the per-run Linear cursor' },
] as const;
