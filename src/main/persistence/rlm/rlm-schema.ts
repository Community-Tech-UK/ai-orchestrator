/**
 * RLM Schema Module
 *
 * Table creation SQL and migrations.
 * Note: This file uses better-sqlite3's db.exec() method for executing SQL,
 * not child_process.exec(). This is safe as it's database SQL execution.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import type { Migration } from './rlm-types';
import type { MigrationRow } from '../rlm-database.types';

/**
 * Migrations to be applied in order
 */
export const MIGRATIONS: Migration[] = [
  // Migration 001: Add optimized indices for common query patterns
  {
    name: '001_add_optimized_indices',
    up: `
      -- Composite index for filtering outcomes by task type and success
      CREATE INDEX IF NOT EXISTS idx_outcomes_task_success
        ON outcomes(task_type, success);

      -- Index for model-specific outcome queries
      CREATE INDEX IF NOT EXISTS idx_outcomes_model
        ON outcomes(model);

      -- Index for cleaning up expired insights
      CREATE INDEX IF NOT EXISTS idx_insights_expires
        ON insights(expires_at);

      -- Index for time-based session queries
      CREATE INDEX IF NOT EXISTS idx_sessions_started
        ON rlm_sessions(started_at);

      -- Index for section checksum lookups (deduplication)
      CREATE INDEX IF NOT EXISTS idx_sections_checksum
        ON context_sections(checksum);

      -- Index for file path lookups in sections
      CREATE INDEX IF NOT EXISTS idx_sections_filepath
        ON context_sections(file_path);

      -- Composite index for section name lookups within a store
      CREATE INDEX IF NOT EXISTS idx_sections_store_name
        ON context_sections(store_id, name);
    `,
    down: `
      DROP INDEX IF EXISTS idx_outcomes_task_success;
      DROP INDEX IF EXISTS idx_outcomes_model;
      DROP INDEX IF EXISTS idx_insights_expires;
      DROP INDEX IF EXISTS idx_sessions_started;
      DROP INDEX IF EXISTS idx_sections_checksum;
      DROP INDEX IF EXISTS idx_sections_filepath;
      DROP INDEX IF EXISTS idx_sections_store_name;
    `
  },

  // Migration 002: Add codebase indexing tables
  {
    name: '002_add_codebase_indexing_tables',
    up: `
      -- Merkle tree storage for change detection
      CREATE TABLE IF NOT EXISTS codebase_trees (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        tree_blob BLOB NOT NULL,
        file_count INTEGER NOT NULL,
        total_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_codebase_trees_store
        ON codebase_trees(store_id);

      -- File metadata for dependency tracking
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

      -- Search analytics
      CREATE TABLE IF NOT EXISTS search_events (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        query TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        results_count INTEGER NOT NULL,
        top_score REAL,
        clicked_indices TEXT,
        search_duration_ms INTEGER,
        hyde_used INTEGER DEFAULT 0,
        rerank_used INTEGER DEFAULT 0,
        FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_search_events_store
        ON search_events(store_id);
      CREATE INDEX IF NOT EXISTS idx_search_events_timestamp
        ON search_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_search_events_query_hash
        ON search_events(query_hash);
    `,
    down: `
      DROP TABLE IF EXISTS search_events;
      DROP TABLE IF EXISTS file_metadata;
      DROP TABLE IF EXISTS codebase_trees;
    `
  },

  // Migration 003: Add FTS5 full-text search table
  {
    name: '003_add_fts5_code_search',
    up: `
      -- Full-text search table using FTS5
      CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
        store_id,
        section_id,
        file_path,
        content,
        symbols,
        tokenize = 'porter unicode61'
      );

      -- Note: Triggers for keeping FTS in sync are handled in application code
      -- because FTS5 triggers require special handling
    `,
    down: `
      DROP TABLE IF EXISTS code_fts;
    `
  }
];

/**
 * Create all tables for the RLM database.
 * Uses better-sqlite3's exec method for SQL execution (not child_process).
 */
export function createTables(db: Database.Database): void {
  // Context Stores table
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_stores (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      total_tokens INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      access_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      config_json TEXT,
      UNIQUE(instance_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stores_instance
      ON context_stores(instance_id);
    CREATE INDEX IF NOT EXISTS idx_stores_accessed
      ON context_stores(last_accessed);
  `);

  // Context Sections table
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_sections (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      checksum TEXT,
      depth INTEGER DEFAULT 0,
      summarizes_json TEXT,
      parent_summary_id TEXT,
      file_path TEXT,
      language TEXT,
      source_url TEXT,
      created_at INTEGER NOT NULL,
      content_file TEXT,
      content_inline TEXT,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sections_store
      ON context_sections(store_id);
    CREATE INDEX IF NOT EXISTS idx_sections_type
      ON context_sections(type);
    CREATE INDEX IF NOT EXISTS idx_sections_offset
      ON context_sections(store_id, start_offset);
    CREATE INDEX IF NOT EXISTS idx_sections_depth
      ON context_sections(store_id, depth);
  `);

  // Search Index table (inverted index)
  db.exec(`
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
  `);

  // RLM Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS rlm_sessions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      total_queries INTEGER DEFAULT 0,
      total_root_tokens INTEGER DEFAULT 0,
      total_sub_query_tokens INTEGER DEFAULT 0,
      estimated_direct_tokens INTEGER DEFAULT 0,
      token_savings_percent REAL DEFAULT 0,
      queries_json TEXT,
      recursive_calls_json TEXT,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_store
      ON rlm_sessions(store_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_instance
      ON rlm_sessions(instance_id);
  `);

  // Outcomes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      success INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER,
      token_usage INTEGER,
      agent_id TEXT,
      model TEXT,
      error_type TEXT,
      prompt_hash TEXT,
      tools_json TEXT,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_task
      ON outcomes(task_type);
    CREATE INDEX IF NOT EXISTS idx_outcomes_timestamp
      ON outcomes(timestamp);
    CREATE INDEX IF NOT EXISTS idx_outcomes_agent
      ON outcomes(agent_id);
  `);

  // Patterns table
  db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      effectiveness REAL NOT NULL,
      sample_size INTEGER NOT NULL,
      last_updated INTEGER NOT NULL,
      metadata_json TEXT,
      UNIQUE(type, key)
    );

    CREATE INDEX IF NOT EXISTS idx_patterns_type
      ON patterns(type);
    CREATE INDEX IF NOT EXISTS idx_patterns_effectiveness
      ON patterns(effectiveness);
  `);

  // Experiences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL UNIQUE,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      success_patterns_json TEXT,
      failure_patterns_json TEXT,
      example_prompts_json TEXT,
      last_updated INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_experiences_task
      ON experiences(task_type);
  `);

  // Insights table
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      confidence REAL NOT NULL,
      supporting_patterns_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_insights_type
      ON insights(type);
    CREATE INDEX IF NOT EXISTS idx_insights_confidence
      ON insights(confidence);
  `);

  // Vectors table (for semantic search)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      content_preview TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES context_sections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vectors_store
      ON vectors(store_id);
    CREATE INDEX IF NOT EXISTS idx_vectors_section
      ON vectors(section_id);
  `);
}

/**
 * Create the migrations tracking table.
 */
export function createMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_migrations_name ON _migrations(name);
  `);
}

/**
 * Compute checksum for a migration.
 */
export function computeMigrationChecksum(migration: Migration): string {
  return crypto.createHash('sha256').update(migration.up).digest('hex').substring(0, 16);
}

/**
 * Get all applied migrations.
 */
export function getAppliedMigrations(db: Database.Database): MigrationRow[] {
  const stmt = db.prepare(`SELECT * FROM _migrations ORDER BY id ASC`);
  return stmt.all() as MigrationRow[];
}

/**
 * Run pending migrations.
 *
 * @param db - Database instance
 * @param onMigrationApplied - Callback when a migration is applied
 * @param onMigrationsComplete - Callback when all migrations are complete
 */
export function runMigrations(
  db: Database.Database,
  onMigrationApplied?: (name: string) => void,
  onMigrationsComplete?: (applied: number) => void
): void {
  const appliedMigrations = getAppliedMigrations(db);
  const appliedNames = new Set(appliedMigrations.map(m => m.name));

  // Verify checksums of applied migrations haven't changed
  for (const applied of appliedMigrations) {
    const migration = MIGRATIONS.find(m => m.name === applied.name);
    if (migration) {
      const expectedChecksum = computeMigrationChecksum(migration);
      if (applied.checksum !== expectedChecksum) {
        throw new Error(
          `Migration checksum mismatch for "${applied.name}". ` +
          `Expected ${expectedChecksum}, got ${applied.checksum}. ` +
          `Migration files should not be modified after being applied.`
        );
      }
    }
  }

  // Apply pending migrations in a transaction
  const pendingMigrations = MIGRATIONS.filter(m => !appliedNames.has(m.name));

  if (pendingMigrations.length === 0) {
    return;
  }

  const applyMigrations = db.transaction(() => {
    for (const migration of pendingMigrations) {
      try {
        db.exec(migration.up);

        const checksum = computeMigrationChecksum(migration);
        const insertStmt = db.prepare(`
          INSERT INTO _migrations (name, applied_at, checksum)
          VALUES (?, ?, ?)
        `);
        insertStmt.run(migration.name, Date.now(), checksum);

        onMigrationApplied?.(migration.name);
      } catch (error) {
        throw new Error(
          `Failed to apply migration "${migration.name}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  });

  applyMigrations();
  onMigrationsComplete?.(pendingMigrations.length);
}

/**
 * Get schema information.
 */
export function getSchemaInfo(
  db: Database.Database,
  schemaVersion: number
): {
  version: number;
  appliedMigrations: MigrationRow[];
  pendingMigrations: string[];
} {
  const applied = getAppliedMigrations(db);
  const appliedNames = new Set(applied.map(m => m.name));
  const pending = MIGRATIONS
    .filter(m => !appliedNames.has(m.name))
    .map(m => m.name);

  return {
    version: schemaVersion,
    appliedMigrations: applied,
    pendingMigrations: pending,
  };
}
