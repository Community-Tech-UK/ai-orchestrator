import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  CONVERSATION_LEDGER_SCHEMA_VERSION,
  createConversationLedgerMigrationsTable,
  createConversationLedgerTables,
  runConversationLedgerMigrations,
} from '../conversation-ledger-schema';

interface TableInfoRow {
  name: string;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  from: string;
  table: string;
  to: string;
  on_delete: string;
}

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
    expect(tables).toContain('provider_event_captures');
    expect(tables).toContain('evidence_records');
    expect(tables).toContain('evidence_cards');
    expect(tables).toContain('evidence_access_log');
    expect(tables).toContain('evidence_deletion_queue');
    expect(tables).toContain('context_evidence_events');
    expect(tables).toContain('conversation_ledger_migrations');
    expect(CONVERSATION_LEDGER_SCHEMA_VERSION).toBe(4);
  });

  it('migrates schema v3 data to 004_context_evidence without losing existing records', () => {
    createSchemaV3(db);
    db.prepare(`
      INSERT INTO conversation_threads (
        id, provider, source_kind, created_at, updated_at, writable,
        native_visibility_mode, sync_status, conflict_status, metadata_json
      ) VALUES ('thread-v3', 'codex', 'provider-native', 1, 2, 0, 'none', 'imported', 'none', '{}')
    `).run();
    db.prepare(`
      INSERT INTO conversation_messages (id, thread_id, role, content, created_at, sequence)
      VALUES ('message-v3', 'thread-v3', 'tool', 'placeholder-result', 3, 1)
    `).run();
    db.prepare(`
      INSERT INTO conversation_checkpoints (
        id, thread_id, up_to_sequence, summary, summarized_message_count,
        summary_tokens, created_at
      ) VALUES ('checkpoint-v3', 'thread-v3', 1, 'placeholder-summary', 1, 1, 4)
    `).run();
    db.prepare(`
      INSERT INTO provider_event_captures (
        event_id, provider, instance_id, sequence, created_at, event_json,
        raw_source, raw_json
      ) VALUES ('capture-v3', 'codex', 'instance-v3', 1, 5, '{}', 'adapter-event:output', '{}')
    `).run();

    runConversationLedgerMigrations(db);

    const threadColumns = db.prepare('PRAGMA table_info(conversation_threads)')
      .all<TableInfoRow>().map(row => row.name);
    expect(threadColumns).toContain('deleted_at');

    expect(tableColumns(db, 'evidence_records')).toEqual([
      'id', 'conversation_id', 'provider', 'provider_thread_ref', 'provider_session_ref',
      'turn_ref', 'tool_call_ref', 'tool_name', 'source_kind', 'source_locator_redacted',
      'status', 'blob_ref', 'keyed_content_id', 'byte_count', 'token_estimate', 'mime_type',
      'sensitivity', 'provenance_trust', 'capture_mode', 'capture_completeness',
      'truncation_reason', 'key_version', 'capture_key', 'created_at', 'completed_at',
      'updated_at',
    ]);
    expect(tableColumns(db, 'evidence_cards')).toEqual([
      'id', 'conversation_id', 'evidence_id', 'blob_ref', 'extractor_kind',
      'extractor_version', 'status', 'sensitivity', 'byte_count', 'token_estimate',
      'created_at', 'updated_at',
    ]);
    expect(tableColumns(db, 'evidence_deletion_queue')).toEqual([
      'id', 'conversation_id', 'evidence_id', 'blob_ref', 'grace_deadline',
      'attempts', 'claim_token', 'claimed_until', 'next_attempt_at',
      'last_error_code', 'completed_at', 'created_at',
    ]);
    expect(tableColumns(db, 'evidence_access_log')).toEqual([
      'id', 'requester', 'conversation_id', 'operation', 'evidence_ids_json',
      'requested_ranges_json', 'outcome_code', 'created_at',
    ]);
    expect(tableColumns(db, 'context_evidence_events')).toEqual([
      'id', 'conversation_id', 'provider', 'event_kind', 'recovery_epoch',
      'threshold_code', 'action_code', 'proof_stage', 'occupancy_used',
      'occupancy_total', 'cumulative_tokens', 'output_bytes', 'provider_request_count',
      'new_evidence_count', 'new_finding_count', 'failure_code', 'duration_ms', 'created_at',
    ]);

    expect(foreignKeys(db, 'evidence_records')).toEqual([
      { id: 0, seq: 0, from: 'conversation_id', table: 'conversation_threads', to: 'id', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys(db, 'evidence_cards')).toEqual([
      { id: 0, seq: 0, from: 'conversation_id', table: 'evidence_records', to: 'conversation_id', onDelete: 'CASCADE' },
      { id: 0, seq: 1, from: 'evidence_id', table: 'evidence_records', to: 'id', onDelete: 'CASCADE' },
      { id: 1, seq: 0, from: 'conversation_id', table: 'conversation_threads', to: 'id', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys(db, 'evidence_access_log')).toEqual([
      { id: 0, seq: 0, from: 'conversation_id', table: 'conversation_threads', to: 'id', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys(db, 'evidence_deletion_queue')).toEqual([]);
    expect(foreignKeys(db, 'context_evidence_events')).toEqual([
      { id: 0, seq: 0, from: 'conversation_id', table: 'conversation_threads', to: 'id', onDelete: 'CASCADE' },
    ]);

    const indexNames = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN (
        'evidence_records', 'evidence_cards', 'evidence_access_log',
        'evidence_deletion_queue', 'context_evidence_events'
      )
    `).all<{ name: string }>().map(row => row.name).filter(name => !name.startsWith('sqlite_auto'))
      .sort();
    expect(indexNames).toEqual([
      'idx_context_evidence_events_conversation_created',
      'idx_evidence_access_log_conversation_created',
      'idx_evidence_cards_conversation_evidence',
      'idx_evidence_deletion_queue_blob',
      'idx_evidence_deletion_queue_claim',
      'idx_evidence_records_capture_key',
      'idx_evidence_records_conversation_created',
      'idx_evidence_records_conversation_id_id',
      'idx_evidence_records_conversation_status',
    ]);

    db.prepare(`
      INSERT INTO evidence_records (
        id, conversation_id, provider, tool_name, source_kind, status, byte_count,
        mime_type, sensitivity, provenance_trust, capture_mode, capture_completeness,
        capture_key, created_at, updated_at
      ) VALUES (?, ?, 'codex', 'placeholder-tool', 'other', 'staging', 0,
        'text/plain', 'normal', 'runtime-authenticated', 'post-retention', 'complete', ?, 10, 10)
    `).run('evidence-a', 'thread-v3', 'logical-result');
    expect(() => db.prepare(`
      INSERT INTO evidence_records (
        id, conversation_id, provider, tool_name, source_kind, status, byte_count,
        mime_type, sensitivity, provenance_trust, capture_mode, capture_completeness,
        capture_key, created_at, updated_at
      ) VALUES (?, ?, 'codex', 'placeholder-tool', 'other', 'staging', 0,
        'text/plain', 'normal', 'runtime-authenticated', 'post-retention', 'complete', ?, 10, 10)
    `).run('evidence-b', 'thread-v3', 'logical-result')).toThrow();

    expect(() => db.prepare(`
      INSERT INTO evidence_records (
        id, conversation_id, provider, tool_name, source_kind, status, byte_count,
        mime_type, sensitivity, provenance_trust, capture_mode, capture_completeness,
        capture_key, created_at, updated_at
      ) VALUES ('invalid-complete', 'thread-v3', 'codex', 'tool', 'other', 'complete', 1,
        'text/plain', 'normal', 'runtime-authenticated', 'post-retention', 'complete',
        'invalid-complete', 10, 10)
    `).run()).toThrow();

    db.prepare(`
      INSERT INTO evidence_records (
        id, conversation_id, provider, tool_name, source_kind, status, blob_ref,
        keyed_content_id, byte_count, mime_type, sensitivity, provenance_trust,
        capture_mode, capture_completeness, key_version, capture_key,
        created_at, completed_at, updated_at
      ) VALUES ('complete-source', 'thread-v3', 'codex', 'tool', 'other', 'complete',
        'opaque/ref', ?, 1, 'text/plain', 'normal', 'runtime-authenticated',
        'post-retention', 'complete', 1, 'complete-source', 10, 11, 11)
    `).run('a'.repeat(64));
    db.prepare(`
      INSERT INTO conversation_threads (
        id, provider, source_kind, created_at, updated_at, writable,
        native_visibility_mode, sync_status, conflict_status, metadata_json
      ) VALUES ('other-thread', 'codex', 'provider-native', 1, 2, 0,
        'none', 'imported', 'none', '{}')
    `).run();
    expect(() => db.prepare(`
      INSERT INTO evidence_cards (
        id, conversation_id, evidence_id, extractor_kind, extractor_version,
        status, sensitivity, byte_count, created_at, updated_at
      ) VALUES ('cross-card', 'other-thread', 'complete-source', 'generic', '1',
        'validated', 'normal', 1, 12, 12)
    `).run()).toThrow();

    expect(db.prepare('SELECT content FROM conversation_messages WHERE id = ?')
      .get<{ content: string }>('message-v3')?.content).toBe('placeholder-result');
    expect(db.prepare('SELECT summary FROM conversation_checkpoints WHERE id = ?')
      .get<{ summary: string }>('checkpoint-v3')?.summary).toBe('placeholder-summary');
    expect(db.prepare('SELECT event_id FROM provider_event_captures WHERE event_id = ?')
      .get<{ event_id: string }>('capture-v3')?.event_id).toBe('capture-v3');
    expect(db.prepare('SELECT version, name FROM conversation_ledger_migrations WHERE version = 4')
      .get<{ version: number; name: string }>()).toEqual({ version: 4, name: '004_context_evidence' });
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

function tableColumns(db: SqliteDriver, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all<TableInfoRow>().map(row => row.name);
}

function foreignKeys(db: SqliteDriver, table: string): {
  id: number;
  seq: number;
  from: string;
  table: string;
  to: string;
  onDelete: string;
}[] {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all<ForeignKeyRow>()
    .map((row) => ({
      id: row.id,
      seq: row.seq,
      from: row.from,
      table: row.table,
      to: row.to,
      onDelete: row.on_delete,
    }))
    .sort((left, right) => left.id - right.id || left.seq - right.seq);
}

function createSchemaV3(db: SqliteDriver): void {
  createConversationLedgerMigrationsTable(db);
  createConversationLedgerTables(db);
  db.exec(`
    CREATE TABLE conversation_checkpoints (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
      up_to_sequence INTEGER NOT NULL,
      up_to_native_id TEXT,
      summary TEXT NOT NULL,
      summarized_message_count INTEGER NOT NULL,
      summary_tokens INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_conversation_checkpoints_thread_seq
      ON conversation_checkpoints(thread_id, up_to_sequence);

    CREATE TABLE provider_event_captures (
      event_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      session_id TEXT,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      raw_source TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX idx_provider_event_captures_instance_created
      ON provider_event_captures(instance_id, created_at ASC);
    CREATE INDEX idx_provider_event_captures_created
      ON provider_event_captures(created_at ASC);
  `);
  const insertMigration = db.prepare(`
    INSERT INTO conversation_ledger_migrations (version, name, applied_at)
    VALUES (?, ?, 1)
  `);
  insertMigration.run(1, '001_initial_conversation_ledger');
  insertMigration.run(2, '002_conversation_checkpoints');
  insertMigration.run(3, '003_provider_event_captures');
}
