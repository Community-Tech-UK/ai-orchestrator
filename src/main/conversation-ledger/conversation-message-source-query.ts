import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';

export interface MessageRow {
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

// Keep the query and expression index identical. Typed keys distinguish missing
// legacy ownership from explicit null, invalid JSON/types and every string owner.
// Removing one ownership key must leave none: SQLite reads the first duplicate
// while JSON.parse reads the last, including equivalent Unicode-escaped keys.
export const MESSAGE_SOURCE_OWNER_SQL = `CASE
  WHEN raw_json IS NULL THEN 'absent'
  WHEN NOT json_valid(raw_json) THEN 'invalid'
  WHEN json_type(json_remove(raw_json, '$.metadata'), '$.metadata') IS NOT NULL THEN 'invalid'
  WHEN json_type(json_remove(raw_json, '$.metadata.instanceId'), '$.metadata.instanceId') IS NOT NULL THEN 'invalid'
  WHEN coalesce(json_type(raw_json, '$.metadata'), '') != 'object' THEN 'absent'
  WHEN json_type(raw_json, '$.metadata.instanceId') IS NULL THEN 'absent'
  WHEN json_type(raw_json, '$.metadata.instanceId') = 'text'
    THEN 'text:' || json_extract(raw_json, '$.metadata.instanceId')
  WHEN json_type(raw_json, '$.metadata.instanceId') = 'null' THEN 'null'
  ELSE 'invalid'
END`;

const ACTIVE_THREAD_SQL = '(SELECT id FROM conversation_threads WHERE id = ? AND deleted_at IS NULL)';
// Harness-authored input (LT-657) is recorded as a system row carrying
// `metadata.internalInput`. Read the actor only from valid JSON so a malformed
// retained row cannot fail an index write or the lookup. Keep the query and
// partial index identical so the planner can use the index.
export const HARNESS_INPUT_ACTOR_SQL = `CASE WHEN json_valid(raw_json)
  THEN json_extract(raw_json, '$.metadata.internalInput.actor') END`;

/**
 * The latest recorded input that started or joined a turn: the user's own
 * message, or input Harness sent itself. Harness input must name this exact
 * instance; legacy ownerless rows are accepted for user messages only.
 */
export const LATEST_INPUT_SOURCE_SQL = `
  SELECT * FROM (
    SELECT *, (${MESSAGE_SOURCE_OWNER_SQL}) AS source_owner_key FROM conversation_messages
    WHERE role = 'user' AND thread_id = ${ACTIVE_THREAD_SQL}
      AND (${MESSAGE_SOURCE_OWNER_SQL}) = 'absent'
    ORDER BY sequence DESC LIMIT 1
  )
  UNION ALL
  SELECT * FROM (
    SELECT *, (${MESSAGE_SOURCE_OWNER_SQL}) AS source_owner_key FROM conversation_messages
    WHERE role = 'user' AND thread_id = ${ACTIVE_THREAD_SQL}
      AND (${MESSAGE_SOURCE_OWNER_SQL}) = ?
    ORDER BY sequence DESC LIMIT 1
  )
  UNION ALL
  SELECT * FROM (
    SELECT *, (${MESSAGE_SOURCE_OWNER_SQL}) AS source_owner_key FROM conversation_messages
    WHERE role = 'system' AND (${HARNESS_INPUT_ACTOR_SQL}) = 'harness'
      AND thread_id = ${ACTIVE_THREAD_SQL}
      AND (${MESSAGE_SOURCE_OWNER_SQL}) = ?
    ORDER BY sequence DESC LIMIT 1
  )
  ORDER BY sequence DESC LIMIT 1
`;

export function getLatestInputSource(
  db: SqliteDriver, threadId: string, instanceId: string | null,
): ConversationMessageRecord | null {
  const ownerKey = instanceId === null ? 'null' : `text:${instanceId}`;
  const row = db.prepare(LATEST_INPUT_SOURCE_SQL)
    .get<MessageRow & { source_owner_key: string }>(threadId, threadId, ownerKey, threadId, ownerKey);
  if (!row) return null;
  const message = messageRowToRecord(row);
  const metadata = message.rawJson?.['metadata'];
  let decodedOwnerKey = 'absent';
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    && Object.hasOwn(metadata, 'instanceId')) {
    const owner = (metadata as Record<string, unknown>)['instanceId'];
    decodedOwnerKey = owner === null ? 'null' : typeof owner === 'string' ? `text:${owner}` : 'invalid';
  }
  if (row.source_owner_key !== decodedOwnerKey
    || (decodedOwnerKey !== 'absent' && decodedOwnerKey !== ownerKey)) {
    throw new Error('SOURCE_OWNER_MISMATCH');
  }
  // SQLite reads the first duplicate key while JSON.parse reads the last; a
  // system row is only a source when both agree that Harness sent it.
  if (message.role === 'system') {
    const internalInput = (metadata as Record<string, unknown>)['internalInput'];
    if (internalInput === null || typeof internalInput !== 'object'
      || (internalInput as Record<string, unknown>)['actor'] !== 'harness') {
      throw new Error('SOURCE_ACTOR_MISMATCH');
    }
  }
  return message;
}

export function messageRowToRecord(row: MessageRow): ConversationMessageRecord {
  let rawJson: Record<string, unknown> | null = null;
  if (row.raw_json) {
    try {
      const parsed: unknown = JSON.parse(row.raw_json);
      rawJson = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown> : {};
    } catch {
      getLogger('ConversationLedgerStore').warn('Corrupt conversation ledger JSON encountered', {
        code: 'INVALID_JSON',
      });
      rawJson = {};
    }
  }
  return {
    id: row.id, threadId: row.thread_id, nativeMessageId: row.native_message_id,
    nativeTurnId: row.native_turn_id, role: row.role, phase: row.phase,
    content: row.content, createdAt: row.created_at, tokenInput: row.token_input,
    tokenOutput: row.token_output, rawRef: row.raw_ref, rawJson,
    sourceChecksum: row.source_checksum, sequence: row.sequence,
  };
}
