import type { ChatUiState } from '../../shared/types/chat.types';
import type { SqliteDriver } from '../db/sqlite-driver';

const DEFAULT_SCOPE = 'default';
const MAX_OPEN_CHAT_IDS = 20;

interface ChatUiStateRow {
  selected_chat_id: string | null;
  open_chat_ids_json: string;
  updated_at: number;
}

export type ChatUiStateInput =
  Pick<ChatUiState, 'selectedChatId' | 'openChatIds'> & { updatedAt?: number };

export class ChatUiStateStore {
  constructor(private readonly db: SqliteDriver) {}

  get(): ChatUiState {
    const row = this.db
      .prepare('SELECT selected_chat_id, open_chat_ids_json, updated_at FROM chat_ui_state WHERE scope = ?')
      .get<ChatUiStateRow>(DEFAULT_SCOPE);
    if (!row) {
      return { selectedChatId: null, openChatIds: [], updatedAt: 0 };
    }
    return {
      selectedChatId: row.selected_chat_id,
      openChatIds: parseOpenChatIds(row.open_chat_ids_json),
      updatedAt: row.updated_at,
    };
  }

  set(input: ChatUiStateInput): ChatUiState {
    const normalized = normalizeChatUiState(input);
    const updatedAt = input.updatedAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO chat_ui_state (
        scope, selected_chat_id, open_chat_ids_json, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        selected_chat_id = excluded.selected_chat_id,
        open_chat_ids_json = excluded.open_chat_ids_json,
        updated_at = excluded.updated_at
    `).run(
      DEFAULT_SCOPE,
      normalized.selectedChatId,
      JSON.stringify(normalized.openChatIds),
      updatedAt,
    );
    return { ...normalized, updatedAt };
  }
}

function normalizeChatUiState(
  input: ChatUiStateInput,
): Pick<ChatUiState, 'selectedChatId' | 'openChatIds'> {
  const seen = new Set<string>();
  const openChatIds: string[] = [];
  const push = (id: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed) || openChatIds.length >= MAX_OPEN_CHAT_IDS) {
      return;
    }
    seen.add(trimmed);
    openChatIds.push(trimmed);
  };

  const selectedChatId = input.selectedChatId?.trim() || null;
  for (const id of input.openChatIds) {
    push(id);
  }
  if (selectedChatId && !seen.has(selectedChatId)) {
    openChatIds.unshift(selectedChatId);
    if (openChatIds.length > MAX_OPEN_CHAT_IDS) {
      openChatIds.length = MAX_OPEN_CHAT_IDS;
    }
  }
  return { selectedChatId, openChatIds };
}

function parseOpenChatIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
      .slice(0, MAX_OPEN_CHAT_IDS);
  } catch {
    return [];
  }
}
