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
