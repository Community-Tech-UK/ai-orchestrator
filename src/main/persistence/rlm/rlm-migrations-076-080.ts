import type { Migration } from './rlm-types';

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
];
