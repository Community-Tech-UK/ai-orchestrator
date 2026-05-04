import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { runConversationLedgerMigrations } from '../conversation-ledger-schema';
import { ConversationLedgerStore } from '../conversation-ledger-store';

describe('ConversationLedgerStore', () => {
  let db: SqliteDriver;
  let store: ConversationLedgerStore;

  beforeEach(() => {
    db = new Database(':memory:') as unknown as SqliteDriver;
    db.pragma('foreign_keys = ON');
    runConversationLedgerMigrations(db);
    store = new ConversationLedgerStore(db);
  });

  it('upserts threads idempotently by provider/native id and round-trips metadata', () => {
    const first = store.upsertThread({
      provider: 'codex',
      nativeThreadId: 'native-1',
      sourceKind: 'provider-native',
      workspacePath: '/tmp/project',
      metadata: { a: 1 },
    });
    const second = store.upsertThread({
      provider: 'codex',
      nativeThreadId: 'native-1',
      sourceKind: 'provider-native',
      title: 'Renamed',
      metadata: { b: 2 },
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Renamed');
    expect(second.metadata).toEqual({ a: 1, b: 2 });
  });

  it('upserts messages with stable ordering and native-message de-dupe', () => {
    const thread = store.upsertThread({ provider: 'codex', nativeThreadId: 'native-1', sourceKind: 'provider-native' });
    store.upsertMessages(thread.id, [
      { nativeMessageId: 'msg-2', role: 'assistant', content: 'second', sequence: 2, rawJson: { b: 2 } },
      { nativeMessageId: 'msg-1', role: 'user', content: 'first', sequence: 1, rawJson: { a: 1 } },
      { nativeMessageId: 'msg-1', role: 'user', content: 'first edited', sequence: 1, rawJson: { c: 3 } },
    ]);

    const messages = store.getMessages(thread.id);
    expect(messages.map(message => message.content)).toEqual(['first edited', 'second']);
    expect(messages[0]!.rawJson).toEqual({ c: 3 });
  });

  it('upserts cursors by thread and kind', () => {
    const thread = store.upsertThread({ provider: 'codex', nativeThreadId: 'native-1', sourceKind: 'provider-native' });
    store.upsertSyncCursor({
      threadId: thread.id,
      provider: 'codex',
      cursorKind: 'rollout',
      cursorValue: '1',
    });
    store.upsertSyncCursor({
      threadId: thread.id,
      provider: 'codex',
      cursorKind: 'rollout',
      cursorValue: '2',
    });

    expect(store.getSyncCursors(thread.id)).toMatchObject([{ cursorKind: 'rollout', cursorValue: '2' }]);
  });

  it('rolls back replace imports when a replacement message violates sequence uniqueness', () => {
    const thread = store.upsertThread({ provider: 'codex', nativeThreadId: 'native-1', sourceKind: 'provider-native' });
    store.upsertMessages(thread.id, [
      { role: 'user', content: 'original', sequence: 1 },
    ]);

    expect(() => store.replaceThreadMessagesFromImport(thread.id, [
      { role: 'user', content: 'new-1', sequence: 1 },
      { role: 'assistant', content: 'new-2', sequence: 1 },
    ])).toThrow();

    expect(store.getMessages(thread.id).map(message => message.content)).toEqual(['original']);
  });
});
