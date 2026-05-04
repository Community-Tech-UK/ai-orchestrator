import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  createConversationLedgerMigrationsTable,
  createConversationLedgerTables,
  runConversationLedgerMigrations,
} from '../conversation-ledger-schema';

describe('conversation ledger schema', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = new Database(':memory:') as unknown as SqliteDriver;
    db.pragma('foreign_keys = ON');
  });

  it('creates tables and runs migrations idempotently', () => {
    createConversationLedgerMigrationsTable(db);
    createConversationLedgerTables(db);
    runConversationLedgerMigrations(db);
    runConversationLedgerMigrations(db);

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all<{ name: string }>().map(row => row.name);

    expect(tables).toContain('conversation_threads');
    expect(tables).toContain('conversation_messages');
    expect(tables).toContain('conversation_sync_cursors');
    expect(tables).toContain('conversation_memory_links');
    expect(tables).toContain('conversation_ledger_migrations');
  });

  it('cascades messages and cursors when a thread is deleted', () => {
    runConversationLedgerMigrations(db);
    db.prepare(`
      INSERT INTO conversation_threads (
        id, provider, source_kind, created_at, updated_at, writable,
        native_visibility_mode, sync_status, conflict_status, metadata_json
      )
      VALUES ('thread-1', 'codex', 'provider-native', 1, 1, 0, 'none', 'imported', 'none', '{}')
    `).run();
    db.prepare(`
      INSERT INTO conversation_messages (id, thread_id, role, content, created_at, sequence)
      VALUES ('message-1', 'thread-1', 'user', 'hello', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO conversation_sync_cursors (
        id, thread_id, provider, cursor_kind, cursor_value, updated_at
      )
      VALUES ('cursor-1', 'thread-1', 'codex', 'file', '1', 1)
    `).run();

    db.prepare('DELETE FROM conversation_threads WHERE id = ?').run('thread-1');

    expect(db.prepare('SELECT COUNT(*) as count FROM conversation_messages').get<{ count: number }>()!.count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as count FROM conversation_sync_cursors').get<{ count: number }>()!.count).toBe(0);
  });
});
