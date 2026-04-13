import type Database from 'better-sqlite3';

export const CAS_SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string[]> = {
  1: [
    `CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS chunks (
      content_hash TEXT PRIMARY KEY,
      ast_normalized_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      name TEXT NOT NULL,
      signature TEXT,
      doc_comment TEXT,
      symbols_json TEXT NOT NULL DEFAULT '[]',
      imports_json TEXT NOT NULL DEFAULT '[]',
      exports_json TEXT NOT NULL DEFAULT '[]',
      raw_text TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_ast_normalized ON chunks(ast_normalized_hash)`,
    `CREATE TABLE IF NOT EXISTS merkle_nodes (
      node_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('file','dir','root')),
      children_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_manifest (
      workspace_hash TEXT NOT NULL,
      path_from_root TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      merkle_leaf_hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      PRIMARY KEY (workspace_hash, path_from_root)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_manifest_workspace ON workspace_manifest(workspace_hash)`,
    `CREATE TABLE IF NOT EXISTS workspace_root (
      workspace_hash TEXT PRIMARY KEY,
      abs_path TEXT NOT NULL UNIQUE,
      head_commit TEXT,
      primary_language TEXT,
      last_indexed_at INTEGER NOT NULL,
      merkle_root_hash TEXT,
      pagerank_json TEXT
    )`,
  ],
  2: [
    `CREATE TABLE IF NOT EXISTS workspace_symbols (
      workspace_hash TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      path_from_root TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      container_name TEXT,
      start_line INTEGER NOT NULL,
      start_character INTEGER NOT NULL,
      end_line INTEGER,
      end_character INTEGER,
      signature TEXT,
      doc_comment TEXT,
      PRIMARY KEY (workspace_hash, symbol_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_symbols_lookup ON workspace_symbols(workspace_hash, name, kind)`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_symbols_file ON workspace_symbols(workspace_hash, path_from_root)`,
  ],
};

export function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  for (const statements of Object.values(MIGRATIONS)) {
    for (const statement of statements) {
      db.prepare(statement).run();
    }
  }

  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  const startVersion = (current?.v ?? 0) + 1;
  for (let version = startVersion; version <= CAS_SCHEMA_VERSION; version += 1) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(version, Date.now());
  }
}
