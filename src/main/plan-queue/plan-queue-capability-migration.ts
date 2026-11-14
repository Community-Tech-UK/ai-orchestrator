/** Capability repairs belong to the existing queue database; queue items still own execution. */
export const PLAN_QUEUE_CAPABILITY_MIGRATION = {
  version: 57,
  name: '057_plan_queue_capability_repairs',
  up: `
    CREATE TABLE plan_queue_capability_repairs (
      id TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL,
      repository TEXT NOT NULL,
      source_run_id TEXT NOT NULL REFERENCES plan_queue_runs(id),
      state TEXT NOT NULL,
      plan_path TEXT NOT NULL UNIQUE,
      repair_run_id TEXT,
      repair_item_id TEXT,
      record_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_capability_active_identity ON plan_queue_capability_repairs(identity_key)
      WHERE state NOT IN ('resolved', 'cancelled');
    CREATE INDEX idx_capability_repair_item ON plan_queue_capability_repairs(repair_item_id);
    CREATE TABLE plan_queue_capability_origins (
      repair_id TEXT NOT NULL REFERENCES plan_queue_capability_repairs(id),
      item_id TEXT NOT NULL REFERENCES plan_queue_items(id),
      check_key TEXT NOT NULL,
      check_name TEXT NOT NULL,
      state TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(repair_id, item_id, check_key)
    );
    CREATE INDEX idx_capability_origin_item ON plan_queue_capability_origins(item_id);
  `,
};
