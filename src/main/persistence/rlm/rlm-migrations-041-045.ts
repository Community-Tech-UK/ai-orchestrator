import type { Migration } from './rlm-types';

/**
 * RLM migrations 041–045.
 *
 * Continuation bucket after the 036–040 range. Keep migrations additive and
 * safe for existing user databases.
 */
export const RLM_MIGRATIONS_041_045: Migration[] = [
  {
    name: '041_browser_permission_grants_node_scope',
    up: `
      ALTER TABLE browser_permission_grants ADD COLUMN node_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_browser_grants_instance_node_expiry
        ON browser_permission_grants(instance_id, node_id, expires_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_browser_grants_instance_node_expiry;
      -- SQLite cannot drop columns portably on older runtimes; leave node_id in place.
    `,
  },
  {
    name: '042_drop_search_index',
    up: `
      DROP INDEX IF EXISTS idx_search_store_term;
      DROP INDEX IF EXISTS idx_search_section;
      DROP TABLE IF EXISTS search_index;
    `,
    down: `
      CREATE TABLE IF NOT EXISTS search_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL,
        term TEXT NOT NULL,
        section_id TEXT NOT NULL,
        line_number INTEGER,
        position INTEGER,
        snippet TEXT,
        FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE,
        FOREIGN KEY (section_id) REFERENCES context_sections(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_search_store_term
        ON search_index(store_id, term);
      CREATE INDEX IF NOT EXISTS idx_search_section
        ON search_index(section_id);
    `,
  },
  {
    name: '043_drop_file_metadata',
    up: `
      DROP INDEX IF EXISTS idx_file_metadata_store;
      DROP INDEX IF EXISTS idx_file_metadata_path;
      DROP INDEX IF EXISTS idx_file_metadata_hash;
      DROP INDEX IF EXISTS idx_file_metadata_language;
      DROP TABLE IF EXISTS file_metadata;
    `,
    down: `
      CREATE TABLE IF NOT EXISTS file_metadata (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        hash TEXT NOT NULL,
        last_modified INTEGER NOT NULL,
        is_entry_point INTEGER DEFAULT 0,
        is_test_file INTEGER DEFAULT 0,
        is_config_file INTEGER DEFAULT 0,
        framework TEXT,
        imports_json TEXT,
        exports_json TEXT,
        symbols_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_metadata_store
        ON file_metadata(store_id);
      CREATE INDEX IF NOT EXISTS idx_file_metadata_path
        ON file_metadata(path);
      CREATE INDEX IF NOT EXISTS idx_file_metadata_hash
        ON file_metadata(hash);
      CREATE INDEX IF NOT EXISTS idx_file_metadata_language
        ON file_metadata(language);
    `,
  },
  // Migration 044: hidden automations.
  //
  // `hidden` keeps an automation's sessions out of the project rail. It is a
  // rail concept only — the Automations page is unchanged, and the rail still
  // shows any run that failed or parked waiting for a human. See
  // `Automation.hidden` for the full contract.
  //
  // The UPDATE is a one-time curation of the operator's existing automations,
  // requested rather than leaving every pre-existing automation visible. Each
  // name below was chosen by reading that automation's own prompt: every one
  // either states it stays silent unless something is wrong, or delivers its
  // result as an email or a board card. Automations that send, publish, write
  // to production, or stop for review are deliberately NOT in this list — a
  // name-pattern rule would have caught the guarded LinkedIn sender, which must
  // never be silent. Renamed or absent rows simply stay visible.
  {
    name: '044_automations_hidden',
    up: `
      ALTER TABLE automations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

      UPDATE automations
      SET hidden = 1
      WHERE name IN (
        'Leads panel uptime check',
        'Work-finder health watchdog',
        'Process outreach review instructions',
        'ComTech inbox review (bids and replies)',
        'Monday work-finder brief',
        'Spark DPS RM6094 monthly MI return',
        'LinkedIn accept and reply live check'
      );
    `,
    down: `
      ALTER TABLE automations DROP COLUMN hidden;
    `,
  },
];
