import type { SqliteDriver } from '../db/sqlite-driver';
import type { ChatProvider, ChatRecord } from '../../shared/types/chat.types';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/types/provider.types';

interface ChatRow {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  model_runtime_target_json: string | null;
  /** Joined from side_chat_links; null for ordinary chats. */
  side_chat_parent_key?: string | null;
  current_cwd: string | null;
  project_id: string | null;
  yolo: number;
  ledger_thread_id: string;
  current_instance_id: string | null;
  created_at: number;
  last_active_at: number;
  archived_at: number | null;
}

export interface ChatInsertInput {
  id: string;
  name: string;
  provider: ChatProvider | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  modelRuntimeTarget?: ModelRuntimeTarget | null;
  currentCwd: string | null;
  projectId?: string | null;
  yolo?: boolean;
  ledgerThreadId: string;
  currentInstanceId?: string | null;
  createdAt?: number;
  lastActiveAt?: number;
  archivedAt?: number | null;
}

export interface ChatUpdateInput {
  name?: string;
  provider?: ChatProvider | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  modelRuntimeTarget?: ModelRuntimeTarget | null;
  currentCwd?: string | null;
  projectId?: string | null;
  yolo?: boolean;
  ledgerThreadId?: string;
  currentInstanceId?: string | null;
  lastActiveAt?: number;
  archivedAt?: number | null;
}

/**
 * Chat rows joined with their sidechat ownership (if any), so every record says
 * whether it already belongs to a parent session.
 */
const SELECT_CHATS = `
  SELECT c.*, scl.parent_key AS side_chat_parent_key
  FROM chats c
  LEFT JOIN side_chat_links scl ON scl.chat_id = c.id`;

export class ChatStore {
  constructor(private readonly db: SqliteDriver) {}

  list(options: { includeArchived?: boolean } = {}): ChatRecord[] {
    const rows = options.includeArchived
      ? this.db.prepare(`${SELECT_CHATS} ORDER BY c.last_active_at DESC`).all<ChatRow>()
      : this.db.prepare(`
          ${SELECT_CHATS}
          WHERE c.archived_at IS NULL
          ORDER BY c.last_active_at DESC
        `).all<ChatRow>();
    return rows.map(rowToChatRecord);
  }

  get(id: string): ChatRecord | null {
    const row = this.db.prepare(`${SELECT_CHATS} WHERE c.id = ?`).get<ChatRow>(id);
    return row ? rowToChatRecord(row) : null;
  }

  getByLedgerThreadId(ledgerThreadId: string): ChatRecord | null {
    const row = this.db.prepare(`${SELECT_CHATS} WHERE c.ledger_thread_id = ?`).get<ChatRow>(ledgerThreadId);
    return row ? rowToChatRecord(row) : null;
  }

  getByInstanceId(instanceId: string): ChatRecord | null {
    const row = this.db.prepare(`${SELECT_CHATS} WHERE c.current_instance_id = ?`).get<ChatRow>(instanceId);
    return row ? rowToChatRecord(row) : null;
  }

  insert(input: ChatInsertInput): ChatRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO chats (
        id, name, provider, model, reasoning_effort, model_runtime_target_json,
        current_cwd, project_id, yolo,
        ledger_thread_id, current_instance_id, created_at, last_active_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.provider,
      input.model ?? null,
      input.reasoningEffort ?? null,
      input.modelRuntimeTarget ? JSON.stringify(input.modelRuntimeTarget) : null,
      input.currentCwd,
      input.projectId ?? null,
      input.yolo ? 1 : 0,
      input.ledgerThreadId,
      input.currentInstanceId ?? null,
      input.createdAt ?? now,
      input.lastActiveAt ?? now,
      input.archivedAt ?? null,
    );
    return this.get(input.id)!;
  }

  update(id: string, input: ChatUpdateInput): ChatRecord {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Chat ${id} not found`);
    }

    this.db.prepare(`
      UPDATE chats SET
        name = ?,
        provider = ?,
        model = ?,
        reasoning_effort = ?,
        model_runtime_target_json = ?,
        current_cwd = ?,
        project_id = ?,
        yolo = ?,
        ledger_thread_id = ?,
        current_instance_id = ?,
        last_active_at = ?,
        archived_at = ?
      WHERE id = ?
    `).run(
      input.name ?? existing.name,
      input.provider !== undefined ? input.provider : existing.provider,
      input.model !== undefined ? input.model : existing.model,
      input.reasoningEffort !== undefined ? input.reasoningEffort : existing.reasoningEffort,
      input.modelRuntimeTarget !== undefined
        ? (input.modelRuntimeTarget ? JSON.stringify(input.modelRuntimeTarget) : null)
        : (existing.modelRuntimeTarget ? JSON.stringify(existing.modelRuntimeTarget) : null),
      input.currentCwd !== undefined ? input.currentCwd : existing.currentCwd,
      input.projectId !== undefined ? input.projectId : existing.projectId,
      input.yolo !== undefined ? (input.yolo ? 1 : 0) : (existing.yolo ? 1 : 0),
      input.ledgerThreadId ?? existing.ledgerThreadId,
      input.currentInstanceId !== undefined ? input.currentInstanceId : existing.currentInstanceId,
      input.lastActiveAt ?? existing.lastActiveAt,
      input.archivedAt !== undefined ? input.archivedAt : existing.archivedAt,
      id,
    );
    return this.get(id)!;
  }

  clearRuntimeLinks(): void {
    this.db.prepare('UPDATE chats SET current_instance_id = NULL').run();
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM chat_session_bindings WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM side_chat_links WHERE chat_id = ?').run(id);
      return this.db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes === 1;
    })();
  }
}

function rowToChatRecord(row: ChatRow): ChatRecord {
  let modelRuntimeTarget: ModelRuntimeTarget | null = null;
  if (row.model_runtime_target_json) {
    try {
      modelRuntimeTarget = JSON.parse(row.model_runtime_target_json) as ModelRuntimeTarget;
    } catch {
      modelRuntimeTarget = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    provider: isChatProvider(row.provider) ? row.provider : null,
    model: row.model,
    reasoningEffort: isReasoningEffort(row.reasoning_effort) ? row.reasoning_effort : null,
    modelRuntimeTarget,
    currentCwd: row.current_cwd,
    projectId: row.project_id,
    yolo: row.yolo === 1,
    ledgerThreadId: row.ledger_thread_id,
    currentInstanceId: row.current_instance_id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    archivedAt: row.archived_at,
    sideChatParentKey: row.side_chat_parent_key ?? null,
  };
}

function isChatProvider(value: string | null): value is ChatProvider {
  return value === 'claude' || value === 'codex' || value === 'gemini'
    || value === 'antigravity' || value === 'copilot' || value === 'grok'
    || value === 'opencode' || value === 'cursor' || value === 'local-model';
}

function isReasoningEffort(value: string | null): value is ReasoningEffort {
  return value !== null && (REASONING_EFFORTS as readonly string[]).includes(value);
}
