import type { Migration } from './rlm-types';

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
];
