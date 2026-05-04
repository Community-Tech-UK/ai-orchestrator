import { randomUUID } from 'crypto';
import { getLogger } from '../logging/logger';
import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  ConversationConflictStatus,
  ConversationListQuery,
  ConversationMessageRecord,
  ConversationMessageUpsertInput,
  ConversationMessagesQuery,
  ConversationProvider,
  ConversationSourceKind,
  ConversationSyncCursorRecord,
  ConversationSyncCursorUpsertInput,
  ConversationSyncStatus,
  ConversationThreadRecord,
  ConversationThreadUpsertInput,
  ReconciliationResult,
} from '../../shared/types/conversation-ledger.types';

const logger = getLogger('ConversationLedgerStore');

interface ThreadRow {
  id: string;
  provider: ConversationProvider;
  native_thread_id: string | null;
  native_session_id: string | null;
  native_source_kind: string | null;
  source_kind: ConversationSourceKind;
  source_path: string | null;
  workspace_path: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_synced_at: number | null;
  writable: number;
  native_visibility_mode: ConversationThreadRecord['nativeVisibilityMode'];
  sync_status: ConversationSyncStatus;
  conflict_status: ConversationConflictStatus;
  parent_conversation_id: string | null;
  metadata_json: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  native_message_id: string | null;
  native_turn_id: string | null;
  role: ConversationMessageRecord['role'];
  phase: string | null;
  content: string;
  created_at: number;
  token_input: number | null;
  token_output: number | null;
  raw_ref: string | null;
  raw_json: string | null;
  source_checksum: string | null;
  sequence: number;
}

interface CursorRow {
  id: string;
  thread_id: string;
  provider: ConversationProvider;
  cursor_kind: string;
  cursor_value: string;
  source_path: string | null;
  source_mtime: number | null;
  last_seen_checksum: string | null;
  updated_at: number;
}

export class ConversationLedgerStore {
  constructor(private readonly db: SqliteDriver) {}

  upsertThread(input: ConversationThreadUpsertInput): ConversationThreadRecord {
    const now = Date.now();
    const existing = input.nativeThreadId
      ? this.findThreadByNativeId(input.provider, input.nativeThreadId)
      : input.id ? this.findThreadById(input.id) : null;
    const id = existing?.id ?? input.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const metadata = { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) };

    this.db.prepare(`
      INSERT INTO conversation_threads (
        id, provider, native_thread_id, native_session_id, native_source_kind,
        source_kind, source_path, workspace_path, title, created_at, updated_at,
        last_synced_at, writable, native_visibility_mode, sync_status,
        conflict_status, parent_conversation_id, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        native_thread_id = excluded.native_thread_id,
        native_session_id = excluded.native_session_id,
        native_source_kind = excluded.native_source_kind,
        source_kind = excluded.source_kind,
        source_path = excluded.source_path,
        workspace_path = excluded.workspace_path,
        title = excluded.title,
        updated_at = excluded.updated_at,
        last_synced_at = excluded.last_synced_at,
        writable = excluded.writable,
        native_visibility_mode = excluded.native_visibility_mode,
        sync_status = excluded.sync_status,
        conflict_status = excluded.conflict_status,
        parent_conversation_id = excluded.parent_conversation_id,
        metadata_json = excluded.metadata_json
    `).run(
      id,
      input.provider,
      input.nativeThreadId ?? existing?.nativeThreadId ?? null,
      input.nativeSessionId ?? existing?.nativeSessionId ?? null,
      input.nativeSourceKind ?? existing?.nativeSourceKind ?? null,
      input.sourceKind,
      input.sourcePath ?? existing?.sourcePath ?? null,
      input.workspacePath ?? existing?.workspacePath ?? null,
      input.title ?? existing?.title ?? null,
      createdAt,
      updatedAt,
      input.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
      boolToInt(input.writable ?? existing?.writable ?? false),
      input.nativeVisibilityMode ?? existing?.nativeVisibilityMode ?? 'none',
      input.syncStatus ?? existing?.syncStatus ?? 'never-synced',
      input.conflictStatus ?? existing?.conflictStatus ?? 'none',
      input.parentConversationId ?? existing?.parentConversationId ?? null,
      stringifyJson(metadata),
    );

    return this.findThreadById(id)!;
  }

  findThreadById(id: string): ConversationThreadRecord | null {
    const row = this.db.prepare('SELECT * FROM conversation_threads WHERE id = ?')
      .get<ThreadRow>(id);
    return row ? threadRowToRecord(row) : null;
  }

  findThreadByNativeId(
    provider: ConversationProvider,
    nativeThreadId: string
  ): ConversationThreadRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM conversation_threads
      WHERE provider = ? AND native_thread_id = ?
    `).get<ThreadRow>(provider, nativeThreadId);
    return row ? threadRowToRecord(row) : null;
  }

  listThreads(query: ConversationListQuery = {}): ConversationThreadRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.provider) {
      where.push('provider = ?');
      params.push(query.provider);
    }
    if (query.workspacePath) {
      where.push('workspace_path = ?');
      params.push(query.workspacePath);
    }
    if (query.sourceKind) {
      where.push('source_kind = ?');
      params.push(query.sourceKind);
    }
    if (query.syncStatus) {
      where.push('sync_status = ?');
      params.push(query.syncStatus);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    const sql = `
      SELECT * FROM conversation_threads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all<ThreadRow>(...params, limit).map(threadRowToRecord);
  }

  upsertMessages(
    threadId: string,
    messages: ConversationMessageUpsertInput[]
  ): ConversationMessageRecord[] {
    const write = this.db.transaction(() => {
      for (const message of messages) {
        this.upsertMessage(threadId, message);
      }
      this.db.prepare('UPDATE conversation_threads SET updated_at = ? WHERE id = ?')
        .run(Date.now(), threadId);
    });
    write();
    return this.getMessages(threadId);
  }

  replaceThreadMessagesFromImport(
    threadId: string,
    messages: ConversationMessageUpsertInput[],
    cursor?: ConversationSyncCursorUpsertInput
  ): ReconciliationResult {
    const before = this.getMessages(threadId).length;
    const write = this.db.transaction(() => {
      this.db.prepare('DELETE FROM conversation_messages WHERE thread_id = ?').run(threadId);
      for (const message of messages) {
        this.upsertMessage(threadId, message);
      }
      if (cursor) {
        this.upsertSyncCursor({ ...cursor, threadId });
      }
    });
    write();
    return {
      threadId,
      provider: cursor?.provider ?? this.findThreadById(threadId)?.provider ?? 'unknown',
      nativeThreadId: this.findThreadById(threadId)?.nativeThreadId ?? null,
      addedMessages: Math.max(messages.length - before, 0),
      updatedMessages: Math.min(messages.length, before),
      deletedMessages: Math.max(before - messages.length, 0),
      cursor,
      syncStatus: 'synced',
      conflictStatus: 'none',
      warnings: [],
    };
  }

  getMessages(
    threadId: string,
    options: ConversationMessagesQuery = {}
  ): ConversationMessageRecord[] {
    const params: unknown[] = [threadId];
    const where = ['thread_id = ?'];
    if (options.afterSequence !== undefined) {
      where.push('sequence > ?');
      params.push(options.afterSequence);
    }
    const limit = options.limit ? Math.max(1, Math.min(options.limit, 1000)) : null;
    const sql = `
      SELECT * FROM conversation_messages
      WHERE ${where.join(' AND ')}
      ORDER BY sequence ASC
      ${limit ? 'LIMIT ?' : ''}
    `;
    if (limit) params.push(limit);
    return this.db.prepare(sql).all<MessageRow>(...params).map(messageRowToRecord);
  }

  upsertSyncCursor(input: ConversationSyncCursorUpsertInput): ConversationSyncCursorRecord {
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO conversation_sync_cursors (
        id, thread_id, provider, cursor_kind, cursor_value, source_path,
        source_mtime, last_seen_checksum, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, cursor_kind) DO UPDATE SET
        provider = excluded.provider,
        cursor_value = excluded.cursor_value,
        source_path = excluded.source_path,
        source_mtime = excluded.source_mtime,
        last_seen_checksum = excluded.last_seen_checksum,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.threadId,
      input.provider,
      input.cursorKind,
      input.cursorValue,
      input.sourcePath ?? null,
      input.sourceMtime ?? null,
      input.lastSeenChecksum ?? null,
      input.updatedAt ?? Date.now(),
    );

    return this.getSyncCursors(input.threadId)
      .find(cursor => cursor.cursorKind === input.cursorKind)!;
  }

  getSyncCursors(threadId: string): ConversationSyncCursorRecord[] {
    return this.db.prepare(`
      SELECT * FROM conversation_sync_cursors
      WHERE thread_id = ?
      ORDER BY cursor_kind ASC
    `).all<CursorRow>(threadId).map(cursorRowToRecord);
  }

  private upsertMessage(threadId: string, input: ConversationMessageUpsertInput): void {
    const existing = input.nativeMessageId
      ? this.db.prepare(`
          SELECT id FROM conversation_messages
          WHERE thread_id = ? AND native_message_id = ?
        `).get<{ id: string }>(threadId, input.nativeMessageId)
      : undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO conversation_messages (
        id, thread_id, native_message_id, native_turn_id, role, phase, content,
        created_at, token_input, token_output, raw_ref, raw_json,
        source_checksum, sequence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        native_message_id = excluded.native_message_id,
        native_turn_id = excluded.native_turn_id,
        role = excluded.role,
        phase = excluded.phase,
        content = excluded.content,
        created_at = excluded.created_at,
        token_input = excluded.token_input,
        token_output = excluded.token_output,
        raw_ref = excluded.raw_ref,
        raw_json = excluded.raw_json,
        source_checksum = excluded.source_checksum,
        sequence = excluded.sequence
    `).run(
      id,
      threadId,
      input.nativeMessageId ?? null,
      input.nativeTurnId ?? null,
      input.role,
      input.phase ?? null,
      input.content,
      input.createdAt ?? Date.now(),
      input.tokenInput ?? null,
      input.tokenOutput ?? null,
      input.rawRef ?? null,
      input.rawJson ? stringifyJson(input.rawJson) : null,
      input.sourceChecksum ?? null,
      input.sequence,
    );
  }
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function stringifyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function parseJsonObject(value: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback;
  } catch (error) {
    logger.warn('Corrupt conversation ledger JSON encountered', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function threadRowToRecord(row: ThreadRow): ConversationThreadRecord {
  return {
    id: row.id,
    provider: row.provider,
    nativeThreadId: row.native_thread_id,
    nativeSessionId: row.native_session_id,
    nativeSourceKind: row.native_source_kind,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    workspacePath: row.workspace_path,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at,
    writable: row.writable === 1,
    nativeVisibilityMode: row.native_visibility_mode,
    syncStatus: row.sync_status,
    conflictStatus: row.conflict_status,
    parentConversationId: row.parent_conversation_id,
    metadata: parseJsonObject(row.metadata_json, {}),
  };
}

function messageRowToRecord(row: MessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    nativeMessageId: row.native_message_id,
    nativeTurnId: row.native_turn_id,
    role: row.role,
    phase: row.phase,
    content: row.content,
    createdAt: row.created_at,
    tokenInput: row.token_input,
    tokenOutput: row.token_output,
    rawRef: row.raw_ref,
    rawJson: row.raw_json ? parseJsonObject(row.raw_json, {}) : null,
    sourceChecksum: row.source_checksum,
    sequence: row.sequence,
  };
}

function cursorRowToRecord(row: CursorRow): ConversationSyncCursorRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    provider: row.provider,
    cursorKind: row.cursor_kind,
    cursorValue: row.cursor_value,
    sourcePath: row.source_path,
    sourceMtime: row.source_mtime,
    lastSeenChecksum: row.last_seen_checksum,
    updatedAt: row.updated_at,
  };
}
