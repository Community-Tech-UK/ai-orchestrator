import type { SqliteDriver } from '../db/sqlite-driver';
import type { ParentContextSnapshot, SideChatParentRef } from '../../shared/types/side-chat.types';
import { sideChatParentKey } from '../../shared/types/side-chat.types';

interface SnapshotRow {
  chat_id: string;
  parent_key: string;
  revision: string;
  captured_at: number;
  quoted_context: string;
  estimated_tokens: number;
  omissions_json: string;
  updated_at: number;
}

export interface StoredContextSnapshot {
  chatId: string;
  parent: SideChatParentRef;
  revision: string;
  capturedAt: number;
  quotedContext: string;
  estimatedTokens: number;
  omissions: string[];
}

export type StoreContextSnapshotInput = ParentContextSnapshot & { chatId: string };

/**
 * Durable latest-effective parent-context representation for one sidechat.
 *
 * Exactly one row per sidechat: overwriting on each refreshed question is the
 * point. A rebuild after restart or provider switching replays the sidechat's
 * own conversation plus THIS snapshot — never a stack of every historical
 * snapshot and never a duplicate of the current question.
 */
export class SideChatContextStore {
  constructor(private readonly db: SqliteDriver) {}

  get(chatId: string): StoredContextSnapshot | null {
    const row = this.db
      .prepareCached('SELECT * FROM side_chat_context_snapshots WHERE chat_id = ?')
      .get<SnapshotRow>(chatId);
    return row ? rowToSnapshot(row) : null;
  }

  put(snapshot: StoreContextSnapshotInput): StoredContextSnapshot {
    const now = Date.now();
    this.db.prepareCached(`
      INSERT INTO side_chat_context_snapshots (
        chat_id, parent_key, revision, captured_at, quoted_context,
        estimated_tokens, omissions_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        parent_key = excluded.parent_key,
        revision = excluded.revision,
        captured_at = excluded.captured_at,
        quoted_context = excluded.quoted_context,
        estimated_tokens = excluded.estimated_tokens,
        omissions_json = excluded.omissions_json,
        updated_at = excluded.updated_at
    `).run(
      snapshot.chatId,
      sideChatParentKey(snapshot.parent),
      snapshot.revision,
      snapshot.capturedAt,
      snapshot.quotedContext,
      snapshot.estimatedTokens,
      JSON.stringify(snapshot.omissions),
      now,
    );
    return this.get(snapshot.chatId)!;
  }

  delete(chatId: string): boolean {
    return this.db
      .prepareCached('DELETE FROM side_chat_context_snapshots WHERE chat_id = ?')
      .run(chatId).changes === 1;
  }
}

function rowToSnapshot(row: SnapshotRow): StoredContextSnapshot {
  const parentKey = row.parent_key;
  let parent: SideChatParentRef;
  if (parentKey.startsWith('chat:')) {
    parent = { kind: 'chat', chatId: parentKey.slice('chat:'.length) };
  } else {
    // The origin node id is workspace provenance only and is not part of the
    // ownership key. The link store persists it; this snapshot reload path
    // returns null and the parent resolver re-resolves provenance on the next
    // capture.
    parent = {
      kind: 'session',
      historyThreadId: parentKey.slice('session:'.length),
      originNodeId: null,
    };
  }
  let omissions: string[] = [];
  try {
    const parsed = JSON.parse(row.omissions_json) as unknown;
    if (Array.isArray(parsed)) {
      omissions = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    omissions = [];
  }
  return {
    chatId: row.chat_id,
    parent,
    revision: row.revision,
    capturedAt: row.captured_at,
    quotedContext: row.quoted_context,
    estimatedTokens: row.estimated_tokens,
    omissions,
  };
}
