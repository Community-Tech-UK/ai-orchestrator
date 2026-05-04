import type { SqliteDriver } from '../db/sqlite-driver';

export const CONVERSATION_LEDGER_SCHEMA_VERSION = 1;

interface LedgerMigration {
  version: number;
  name: string;
  up: string;
}

const MIGRATIONS: LedgerMigration[] = [
  {
    version: 1,
    name: '001_initial_conversation_ledger',
    up: `
      CREATE TABLE IF NOT EXISTS conversation_threads (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        native_thread_id TEXT,
        native_session_id TEXT,
        native_source_kind TEXT,
        source_kind TEXT NOT NULL,
        source_path TEXT,
        workspace_path TEXT,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_synced_at INTEGER,
        writable INTEGER NOT NULL DEFAULT 0,
        native_visibility_mode TEXT NOT NULL DEFAULT 'none',
        sync_status TEXT NOT NULL DEFAULT 'never-synced',
        conflict_status TEXT NOT NULL DEFAULT 'none',
        parent_conversation_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_threads_provider_native
        ON conversation_threads(provider, native_thread_id)
        WHERE native_thread_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_conversation_threads_workspace_updated
        ON conversation_threads(workspace_path, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        native_message_id TEXT,
        native_turn_id TEXT,
        role TEXT NOT NULL,
        phase TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        token_input INTEGER,
        token_output INTEGER,
        raw_ref TEXT,
        raw_json TEXT,
        source_checksum TEXT,
        sequence INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_thread_native
        ON conversation_messages(thread_id, native_message_id)
        WHERE native_message_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_thread_sequence
        ON conversation_messages(thread_id, sequence);

      CREATE TABLE IF NOT EXISTS conversation_sync_cursors (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        cursor_kind TEXT NOT NULL,
        cursor_value TEXT NOT NULL,
        source_path TEXT,
        source_mtime INTEGER,
        last_seen_checksum TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sync_cursors_thread_kind
        ON conversation_sync_cursors(thread_id, cursor_kind);

      CREATE TABLE IF NOT EXISTS conversation_memory_links (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES conversation_messages(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL,
        memory_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

export function createConversationLedgerMigrationsTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_ledger_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function createConversationLedgerTables(db: SqliteDriver): void {
  db.exec(MIGRATIONS[0]!.up);
}

export function runConversationLedgerMigrations(db: SqliteDriver): void {
  createConversationLedgerMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT version FROM conversation_ledger_migrations').all<{ version: number }>()
      .map(row => row.version)
  );

  const run = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.up);
      db.prepare(`
        INSERT INTO conversation_ledger_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, Date.now());
    }
  });

  run();
}
