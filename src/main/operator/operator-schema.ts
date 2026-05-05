import type { SqliteDriver } from '../db/sqlite-driver';

export function createOperatorTables(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      autonomy_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      goal TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS operator_run_nodes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_node_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      target_project_id TEXT,
      target_path TEXT,
      title TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      external_ref_kind TEXT,
      external_ref_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT,
      FOREIGN KEY(run_id) REFERENCES operator_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_operator_run_nodes_run
      ON operator_run_nodes(run_id, status, type);

    CREATE TABLE IF NOT EXISTS operator_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES operator_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_operator_run_events_run
      ON operator_run_events(run_id, created_at);

    CREATE TABLE IF NOT EXISTS operator_projects (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      source TEXT NOT NULL,
      git_root TEXT,
      remotes_json TEXT NOT NULL,
      current_branch TEXT,
      is_pinned INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operator_projects_path
      ON operator_projects(canonical_path);

    CREATE TABLE IF NOT EXISTS operator_project_aliases (
      project_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      alias_key TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY(project_id, alias_key),
      FOREIGN KEY(project_id) REFERENCES operator_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_operator_project_aliases_key
      ON operator_project_aliases(alias_key);

    CREATE TABLE IF NOT EXISTS operator_project_scan_roots (
      root_path TEXT PRIMARY KEY,
      last_scanned_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operator_instance_links (
      instance_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      recovery_state TEXT NOT NULL
    );
  `);
}
