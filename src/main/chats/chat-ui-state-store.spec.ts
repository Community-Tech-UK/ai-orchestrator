import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { ChatUiStateStore } from './chat-ui-state-store';

interface TableInfoRow { name: string; }

describe('ChatUiStateStore', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function freshDb(): SqliteDriver {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    return db;
  }

  it('creates the chat_ui_state table with the operator schema', () => {
    const db = freshDb();
    const columns = db
      .prepare('PRAGMA table_info(chat_ui_state)')
      .all() as TableInfoRow[];

    expect(columns.map((column) => column.name)).toEqual([
      'scope',
      'selected_chat_id',
      'open_chat_ids_json',
      'updated_at',
    ]);
  });

  it('round-trips selected and open chat ids for crash restore', () => {
    const store = new ChatUiStateStore(freshDb());

    const saved = store.set({
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2', 'chat-1'],
      updatedAt: 1234,
    });

    expect(saved).toEqual({
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2'],
      updatedAt: 1234,
    });
    expect(store.get()).toEqual(saved);
  });

  it('includes the selected chat in openChatIds even when the renderer omits it', () => {
    const store = new ChatUiStateStore(freshDb());

    expect(store.set({
      selectedChatId: 'chat-3',
      openChatIds: ['chat-1'],
      updatedAt: 10,
    })).toEqual({
      selectedChatId: 'chat-3',
      openChatIds: ['chat-3', 'chat-1'],
      updatedAt: 10,
    });
  });
});
