import type { SqliteDriver } from '../db/sqlite-driver';
import {
  sideChatParentKey,
  type SideChatAuthority,
  type SideChatLink,
  type SideChatParentRef,
} from '../../shared/types/side-chat.types';

interface SideChatLinkRow {
  chat_id: string;
  parent_kind: string;
  parent_key: string;
  parent_chat_id: string | null;
  parent_history_thread_id: string | null;
  parent_origin_node_id: string | null;
  authority: string;
  last_read_assistant_sequence: number;
  created_at: number;
  updated_at: number;
}

function rowToLink(row: SideChatLinkRow): SideChatLink {
  return {
    chatId: row.chat_id,
    parent: rowToParentRef(row),
    authority: row.authority === 'inherit-parent' ? 'inherit-parent' : 'inherit-parent',
    lastReadAssistantSequence: row.last_read_assistant_sequence,
  };
}

function rowToParentRef(row: SideChatLinkRow): SideChatParentRef {
  if (row.parent_kind === 'chat' && row.parent_chat_id) {
    return { kind: 'chat', chatId: row.parent_chat_id };
  }
  return {
    kind: 'session',
    historyThreadId: row.parent_history_thread_id ?? '',
    originNodeId: row.parent_origin_node_id,
  };
}

/**
 * Durable sidechat-to-parent ownership and read state.
 *
 * Ownership is keyed by the stable logical parent identity
 * ({@link sideChatParentKey}) and deliberately excludes runtime instance ids,
 * provider session ids and working directories so a parent's runtime can be
 * replaced without detaching its sidechats. `parent_origin_node_id` is kept as
 * workspace provenance only.
 */
export class SideChatLinkStore {
  constructor(private readonly db: SqliteDriver) {}

  get(chatId: string): SideChatLink | null {
    const row = this.db
      .prepareCached('SELECT * FROM side_chat_links WHERE chat_id = ?')
      .get<SideChatLinkRow>(chatId);
    return row ? rowToLink(row) : null;
  }

  listForParent(parent: SideChatParentRef): SideChatLink[] {
    const rows = this.db
      .prepareCached(
        'SELECT * FROM side_chat_links WHERE parent_key = ? ORDER BY created_at ASC',
      )
      .all<SideChatLinkRow>(sideChatParentKey(parent));
    return rows.map(rowToLink);
  }

  /** List non-archived links for a parent (joins against the backing chat). */
  listActiveForParent(parent: SideChatParentRef): SideChatLink[] {
    const rows = this.db
      .prepareCached(
        `SELECT scl.* FROM side_chat_links scl
         JOIN chats c ON c.id = scl.chat_id
         WHERE scl.parent_key = ? AND c.archived_at IS NULL
         ORDER BY scl.created_at ASC`,
      )
      .all<SideChatLinkRow>(sideChatParentKey(parent));
    return rows.map(rowToLink);
  }

  listAll(): SideChatLink[] {
    const rows = this.db
      .prepareCached('SELECT * FROM side_chat_links ORDER BY created_at ASC')
      .all<SideChatLinkRow>();
    return rows.map(rowToLink);
  }

  /**
   * Persist a sidechat relation. Idempotent per `chatId`: re-inserting the same
   * chat id updates the parent/authority while preserving the read high-water
   * mark (relinking must not silently mark answers unread).
   */
  insert(link: SideChatLink): SideChatLink {
    const now = Date.now();
    const parentKey = sideChatParentKey(link.parent);
    this.db.prepareCached(`
      INSERT INTO side_chat_links (
        chat_id, parent_kind, parent_key, parent_chat_id,
        parent_history_thread_id, parent_origin_node_id, authority,
        last_read_assistant_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        parent_kind = excluded.parent_kind,
        parent_key = excluded.parent_key,
        parent_chat_id = excluded.parent_chat_id,
        parent_history_thread_id = excluded.parent_history_thread_id,
        parent_origin_node_id = excluded.parent_origin_node_id,
        authority = excluded.authority,
        updated_at = excluded.updated_at
    `).run(
      link.chatId,
      link.parent.kind,
      parentKey,
      link.parent.kind === 'chat' ? link.parent.chatId : null,
      link.parent.kind === 'session' ? link.parent.historyThreadId : null,
      link.parent.kind === 'session' ? link.parent.originNodeId : null,
      link.authority satisfies SideChatAuthority,
      Math.max(0, Math.floor(link.lastReadAssistantSequence)),
      now,
      now,
    );
    return this.get(link.chatId)!;
  }

  /**
   * Atomically persist a sidechat relation together with whatever backing row
   * `createBacker` writes (normally the `chats` insert). Either both land or
   * neither does, so an orphan link or an unlinked sidechat row cannot be left
   * behind by an interrupted creation.
   */
  insertWithBacker<T>(link: SideChatLink, createBacker: () => T): T {
    return this.db.transaction(() => {
      const backer = createBacker();
      this.insert(link);
      return backer;
    })();
  }

  /**
   * Advance the read high-water mark. Monotonic: a lower or equal sequence is a
   * no-op, so a concurrent acknowledgement can never rewind the mark and make
   * a viewed answer unread again.
   */
  markRead(chatId: string, throughSequence: number): SideChatLink | null {
    const sequence = Math.max(0, Math.floor(throughSequence));
    this.db.prepareCached(`
      UPDATE side_chat_links
      SET last_read_assistant_sequence = MAX(last_read_assistant_sequence, ?),
          updated_at = ?
      WHERE chat_id = ?
    `).run(sequence, Date.now(), chatId);
    return this.get(chatId);
  }

  /** Drop a deleted child's relation. Called from chat deletion cleanup. */
  delete(chatId: string): boolean {
    return this.db
      .prepareCached('DELETE FROM side_chat_links WHERE chat_id = ?')
      .run(chatId).changes === 1;
  }
}
