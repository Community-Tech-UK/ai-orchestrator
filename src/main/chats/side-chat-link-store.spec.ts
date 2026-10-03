import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { ChatStore } from './chat-store';
import { SideChatLinkStore } from './side-chat-link-store';
import {
  sideChatParentKey,
  sideChatParentsEqual,
  type SideChatLink,
  type SideChatParentRef,
} from '../../shared/types/side-chat.types';

const PARENT_CHAT: SideChatParentRef = { kind: 'chat', chatId: 'parent-chat-a' };
const PARENT_SESSION: SideChatParentRef = {
  kind: 'session',
  historyThreadId: 'thread-a',
  originNodeId: 'node-1',
};

function link(chatId: string, parent: SideChatParentRef, read = 0): SideChatLink {
  return {
    chatId,
    parent,
    authority: 'inherit-parent',
    lastReadAssistantSequence: read,
  };
}

describe('sideChatParentKey', () => {
  it('keys a chat parent by chat id and a session parent by history thread id', () => {
    expect(sideChatParentKey(PARENT_CHAT)).toBe('chat:parent-chat-a');
    expect(sideChatParentKey(PARENT_SESSION)).toBe('session:thread-a');
  });

  it('excludes origin node id from the ownership key', () => {
    const moved: SideChatParentRef = {
      kind: 'session',
      historyThreadId: 'thread-a',
      originNodeId: 'node-replacement',
    };
    expect(sideChatParentKey(moved)).toBe(sideChatParentKey(PARENT_SESSION));
    expect(sideChatParentsEqual(moved, PARENT_SESSION)).toBe(true);
  });

  it('separates parents that share a working directory', () => {
    const otherChat: SideChatParentRef = { kind: 'chat', chatId: 'parent-chat-b' };
    const otherSession: SideChatParentRef = {
      kind: 'session',
      historyThreadId: 'thread-b',
      originNodeId: 'node-1',
    };
    expect(sideChatParentKey(PARENT_CHAT)).not.toBe(sideChatParentKey(otherChat));
    expect(sideChatParentKey(PARENT_SESSION)).not.toBe(sideChatParentKey(otherSession));
    expect(sideChatParentKey(PARENT_CHAT)).not.toBe(sideChatParentKey(PARENT_SESSION));
  });
});

describe('SideChatLinkStore', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function fresh(): { db: SqliteDriver; links: SideChatLinkStore; chats: ChatStore } {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    return { db, links: new SideChatLinkStore(db), chats: new ChatStore(db) };
  }

  function insertChat(chats: ChatStore, id: string, ledgerThreadId: string): void {
    chats.insert({
      id,
      name: `Chat ${id}`,
      provider: 'claude',
      currentCwd: '/work',
      ledgerThreadId,
    });
  }

  it('round-trips a chat parent link', () => {
    const { links } = fresh();
    const stored = links.insert(link('child-1', PARENT_CHAT));
    expect(stored.chatId).toBe('child-1');
    expect(stored.parent).toEqual(PARENT_CHAT);
    expect(stored.authority).toBe('inherit-parent');
    expect(stored.lastReadAssistantSequence).toBe(0);
    expect(links.get('child-1')).toEqual(stored);
  });

  it('round-trips a session parent link including origin node provenance', () => {
    const { links } = fresh();
    const stored = links.insert(link('child-1', PARENT_SESSION));
    expect(stored.parent).toEqual(PARENT_SESSION);
    expect(links.listForParent(PARENT_SESSION).map((l) => l.chatId)).toEqual(['child-1']);
  });

  it('keeps two parents in one directory in separate lists', () => {
    const { links } = fresh();
    const parentB: SideChatParentRef = { kind: 'chat', chatId: 'parent-chat-b' };
    links.insert(link('child-a1', PARENT_CHAT));
    links.insert(link('child-b1', parentB));
    links.insert(link('child-b2', parentB));

    expect(links.listForParent(PARENT_CHAT).map((l) => l.chatId)).toEqual(['child-a1']);
    expect(links.listForParent(parentB).map((l) => l.chatId)).toEqual(['child-b1', 'child-b2']);
  });

  it('allows several conversations per parent with independent read marks', () => {
    const { links } = fresh();
    links.insert(link('child-1', PARENT_SESSION, 0));
    links.insert(link('child-2', PARENT_SESSION, 0));
    links.markRead('child-1', 5);

    expect(links.get('child-1')?.lastReadAssistantSequence).toBe(5);
    expect(links.get('child-2')?.lastReadAssistantSequence).toBe(0);
    expect(links.listForParent(PARENT_SESSION)).toHaveLength(2);
  });

  it('treats a replacement runtime as the same parent', () => {
    const { links } = fresh();
    links.insert(link('child-1', PARENT_SESSION));
    const replaced: SideChatParentRef = {
      kind: 'session',
      historyThreadId: 'thread-a',
      originNodeId: 'node-2',
    };
    links.insert(link('child-1', replaced));
    expect(links.listForParent(replaced).map((l) => l.chatId)).toEqual(['child-1']);
    expect(links.listForParent(PARENT_SESSION).map((l) => l.chatId)).toEqual(['child-1']);
  });

  it('advances read positions monotonically', () => {
    const { links } = fresh();
    links.insert(link('child-1', PARENT_CHAT));
    expect(links.markRead('child-1', 7)?.lastReadAssistantSequence).toBe(7);
    expect(links.markRead('child-1', 3)?.lastReadAssistantSequence).toBe(7);
    expect(links.markRead('child-1', 7)?.lastReadAssistantSequence).toBe(7);
    expect(links.markRead('child-1', 12)?.lastReadAssistantSequence).toBe(12);
    expect(links.markRead('missing-chat', 4)).toBeNull();
  });

  it('preserves the read high-water mark across a relink', () => {
    const { links } = fresh();
    links.insert(link('child-1', PARENT_CHAT));
    links.markRead('child-1', 9);
    links.insert(link('child-1', PARENT_CHAT));
    expect(links.get('child-1')?.lastReadAssistantSequence).toBe(9);
  });

  it('persists the relation and backing chat atomically', () => {
    const { db, links, chats } = fresh();
    const stored = links.insertWithBacker(link('child-atomic', PARENT_CHAT), () =>
      chats.insert({
        id: 'child-atomic',
        name: 'Atomic child',
        provider: 'codex',
        currentCwd: '/work',
        ledgerThreadId: 'thread-atomic',
      }),
    );
    expect(stored.id).toBe('child-atomic');
    expect(chats.get('child-atomic')).not.toBeNull();
    expect(links.get('child-atomic')).not.toBeNull();

    // A throwing backer rolls both writes back.
    expect(() =>
      links.insertWithBacker(link('child-orphan', PARENT_CHAT), () => {
        chats.insert({
          id: 'child-orphan',
          name: 'Orphan',
          provider: 'codex',
          currentCwd: '/work',
          ledgerThreadId: 'thread-orphan',
        });
        throw new Error('creation failed mid-flight');
      }),
    ).toThrow('creation failed mid-flight');
    expect(chats.get('child-orphan')).toBeNull();
    expect(links.get('child-orphan')).toBeNull();

    const remaining = db
      .prepare('SELECT chat_id FROM side_chat_links ORDER BY chat_id')
      .all<{ chat_id: string }>();
    expect(remaining.map((row) => row.chat_id)).toEqual(['child-atomic']);
  });

  it('supports concurrent creates with independent provider selections', () => {
    const { links, chats } = fresh();
    links.insertWithBacker(link('child-claude', PARENT_SESSION), () =>
      chats.insert({
        id: 'child-claude',
        name: 'Claude question',
        provider: 'claude',
        model: 'opus',
        currentCwd: '/work',
        ledgerThreadId: 'thread-claude',
      }),
    );
    links.insertWithBacker(link('child-codex', PARENT_SESSION), () =>
      chats.insert({
        id: 'child-codex',
        name: 'Codex question',
        provider: 'codex',
        model: 'gpt-5',
        currentCwd: '/work',
        ledgerThreadId: 'thread-codex',
      }),
    );

    expect(chats.get('child-claude')?.provider).toBe('claude');
    expect(chats.get('child-claude')?.ledgerThreadId).toBe('thread-claude');
    expect(chats.get('child-codex')?.provider).toBe('codex');
    expect(chats.get('child-codex')?.ledgerThreadId).toBe('thread-codex');
    expect(links.listForParent(PARENT_SESSION).map((l) => l.chatId)).toEqual([
      'child-claude',
      'child-codex',
    ]);
  });

  it('cleans up the relation when the child chat is deleted', () => {
    const { links, chats } = fresh();
    insertChat(chats, 'child-1', 'thread-1');
    insertChat(chats, 'child-2', 'thread-2');
    links.insert(link('child-1', PARENT_CHAT));
    links.insert(link('child-2', PARENT_CHAT));

    expect(chats.delete('child-1')).toBe(true);
    expect(links.get('child-1')).toBeNull();
    expect(links.listForParent(PARENT_CHAT).map((l) => l.chatId)).toEqual(['child-2']);
    expect(chats.get('child-2')).not.toBeNull();
  });
});

describe('side_chat_links migration', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function freshLegacyDb(): SqliteDriver {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    db.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        current_cwd TEXT,
        project_id TEXT,
        yolo INTEGER NOT NULL DEFAULT 0,
        ledger_thread_id TEXT NOT NULL UNIQUE,
        current_instance_id TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        archived_at INTEGER
      );
    `);
    // Ordinary chats plus legacy sidechats created by the old panel (named
    // 'Side chat', never linked to a parent). Their transcript ids must survive
    // migration unchanged and they must not acquire guessed parents.
    const rows: Array<[string, string, string]> = [
      ['chat-ordinary', 'Provider hardening', 'thread-ordinary'],
      ['chat-legacy-side-1', 'Side chat', 'thread-legacy-side-1'],
      ['chat-legacy-side-2', 'Side chat', 'thread-legacy-side-2'],
    ];
    const insert = db.prepare(`
      INSERT INTO chats (
        id, name, provider, model, current_cwd, project_id, yolo,
        ledger_thread_id, current_instance_id, created_at, last_active_at, archived_at
      ) VALUES (?, ?, 'claude', NULL, '/work', NULL, 0, ?, NULL, 1000, 1000, NULL)
    `);
    for (const [id, name, thread] of rows) {
      insert.run(id, name, thread);
    }
    return db;
  }

  it('adds side_chat_links to an old database without touching existing chats', () => {
    const db = freshLegacyDb();
    createOperatorTables(db);

    const chats = new ChatStore(db);
    expect(chats.get('chat-ordinary')?.ledgerThreadId).toBe('thread-ordinary');
    expect(chats.get('chat-legacy-side-1')?.ledgerThreadId).toBe('thread-legacy-side-1');
    expect(chats.get('chat-legacy-side-2')?.ledgerThreadId).toBe('thread-legacy-side-2');

    const links = new SideChatLinkStore(db);
    expect(links.listAll()).toEqual([]);
  });

  it('is idempotent when the migration runs twice and guesses no relationships', () => {
    const db = freshLegacyDb();
    createOperatorTables(db);
    const before = db
      .prepare('SELECT id, name, ledger_thread_id FROM chats ORDER BY id')
      .all<{ id: string; name: string; ledger_thread_id: string }>();

    createOperatorTables(db);

    const after = db
      .prepare('SELECT id, name, ledger_thread_id FROM chats ORDER BY id')
      .all<{ id: string; name: string; ledger_thread_id: string }>();
    expect(after).toEqual(before);

    const links = new SideChatLinkStore(db);
    expect(links.listAll()).toEqual([]);
    expect(links.get('chat-legacy-side-1')).toBeNull();
    expect(links.get('chat-legacy-side-2')).toBeNull();

    // Explicit attachment afterwards is the only way a legacy sidechat gains a
    // parent; migration never guesses one from name or directory.
    links.insert({
      chatId: 'chat-legacy-side-1',
      parent: { kind: 'chat', chatId: 'chat-ordinary' },
      authority: 'inherit-parent',
      lastReadAssistantSequence: 0,
    });
    expect(links.listForParent({ kind: 'chat', chatId: 'chat-ordinary' })).toHaveLength(1);
    expect(links.get('chat-legacy-side-2')).toBeNull();
  });
});
