import type { SqliteDriver } from '../db/sqlite-driver';

/**
 * `session_messages` — audit trail for every cross-session messaging delivery
 * attempt (spec requirement 6). Message bodies are not retained verbatim
 * here; `content_length`/`content_hash` are sufficient since the target's own
 * transcript already keeps the full text. Reuses the operator database
 * (`OperatorDatabase`) rather than opening a new sqlite file, matching how
 * `orchestrator-tools-rpc-server.ts` already piggybacks lightweight audit
 * tables on that connection.
 */
export function createSessionMessagesTables(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      source_instance_id TEXT NOT NULL,
      source_display_name TEXT NOT NULL,
      target_instance_id TEXT,
      target_display_name TEXT,
      content_length INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      hop_count INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_messages_source_target
      ON session_messages(source_instance_id, target_instance_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_session_messages_created_at
      ON session_messages(created_at DESC);
  `);
}
