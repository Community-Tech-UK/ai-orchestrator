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

  describe('appendMessagesWithThreadTouch', () => {
    it('assigns contiguous sequences, returns the appended records, and touches the thread', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'native-1', sourceKind: 'orchestrator', updatedAt: 1 });
      store.upsertMessages(thread.id, [{ role: 'user', content: 'first', sequence: 1 }]);

      const records = store.appendMessagesWithThreadTouch(thread.id, [
        { nativeMessageId: 'a', role: 'assistant', content: 'second' },
        { nativeMessageId: 'b', role: 'tool', content: 'third' },
      ]);

      expect(records).not.toBeNull();
      expect(records!.map(r => r.content)).toEqual(['second', 'third']);
      expect(records!.map(r => r.sequence)).toEqual([2, 3]);
      // Persisted transcript reflects the batch in order.
      expect(store.getMessages(thread.id).map(m => m.content)).toEqual(['first', 'second', 'third']);
      // Thread updated_at advanced past its seeded value.
      expect(store.findThreadById(thread.id)!.updatedAt).toBeGreaterThan(1);
    });

    it('returns null when the thread does not exist (no write)', () => {
      const records = store.appendMessagesWithThreadTouch('missing-thread', [
        { role: 'user', content: 'x' },
      ]);
      expect(records).toBeNull();
    });

    it('is a no-op returning [] for an empty batch', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      expect(store.appendMessagesWithThreadTouch(thread.id, [])).toEqual([]);
    });
  });

  describe('getRecentMessages', () => {
    it('returns the last N messages in ascending sequence order', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.upsertMessages(thread.id, [
        { role: 'user', content: 'm1', sequence: 1 },
        { role: 'assistant', content: 'm2', sequence: 2 },
        { role: 'user', content: 'm3', sequence: 3 },
        { role: 'assistant', content: 'm4', sequence: 4 },
      ]);

      expect(store.getRecentMessages(thread.id, 2).map(m => m.content)).toEqual(['m3', 'm4']);
      expect(store.getRecentMessages(thread.id, 10).map(m => m.content)).toEqual(['m1', 'm2', 'm3', 'm4']);
    });
  });

  describe('hasMessageWithNativeId', () => {
    it('reports existence by native message id without loading the transcript', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.upsertMessages(thread.id, [
        { nativeMessageId: 'evt-1', role: 'system', content: 'x', sequence: 1 },
      ]);

      expect(store.hasMessageWithNativeId(thread.id, 'evt-1')).toBe(true);
      expect(store.hasMessageWithNativeId(thread.id, 'evt-2')).toBe(false);
    });
  });

  describe('conversation checkpoints (§4.4)', () => {
    it('returns null when no checkpoint exists', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      expect(store.getLatestCheckpoint(thread.id)).toBeNull();
    });

    it('writes a checkpoint and reads it back', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      const written = store.writeCheckpoint(thread.id, {
        upToSequence: 10,
        upToNativeId: 'msg-10',
        summary: 'Earlier work summary.',
        summarizedMessageCount: 10,
        summaryTokens: 4,
      });
      expect(written.threadId).toBe(thread.id);
      expect(store.getLatestCheckpoint(thread.id)).toMatchObject({
        upToSequence: 10,
        upToNativeId: 'msg-10',
        summary: 'Earlier work summary.',
        summarizedMessageCount: 10,
      });
    });

    it('upserts (replaces) on the same upToSequence rather than duplicating', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.writeCheckpoint(thread.id, {
        upToSequence: 5, upToNativeId: 'm5', summary: 'v1', summarizedMessageCount: 5, summaryTokens: 1,
      });
      store.writeCheckpoint(thread.id, {
        upToSequence: 5, upToNativeId: 'm5', summary: 'v2', summarizedMessageCount: 5, summaryTokens: 1,
      });
      expect(store.getLatestCheckpoint(thread.id)?.summary).toBe('v2');
    });

    it('getLatestCheckpoint returns the one covering the largest prefix', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.writeCheckpoint(thread.id, {
        upToSequence: 20, upToNativeId: 'm20', summary: 'later', summarizedMessageCount: 20, summaryTokens: 1,
      });
      store.writeCheckpoint(thread.id, {
        upToSequence: 10, upToNativeId: 'm10', summary: 'earlier', summarizedMessageCount: 10, summaryTokens: 1,
      });
      expect(store.getLatestCheckpoint(thread.id)?.upToSequence).toBe(20);
    });

    it('isolates checkpoints per thread', () => {
      const a = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'a', sourceKind: 'orchestrator' });
      const b = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'b', sourceKind: 'orchestrator' });
      store.writeCheckpoint(a.id, {
        upToSequence: 3, upToNativeId: 'a3', summary: 'A', summarizedMessageCount: 3, summaryTokens: 1,
      });
      expect(store.getLatestCheckpoint(a.id)?.summary).toBe('A');
      expect(store.getLatestCheckpoint(b.id)).toBeNull();
    });
  });

  describe('provider event captures', () => {
    it('serializes cyclic canonical metadata without losing the capture batch', () => {
      const metadata: Record<string, unknown> = {};
      metadata['self'] = metadata;

      expect(() => store.appendProviderEventCaptures([
        {
          eventId: 'cyclic-event', provider: 'claude', instanceId: 'instance-1', sessionId: null,
          sequence: 0, createdAt: 1,
          event: { kind: 'output', content: 'safe', metadata },
          raw: { source: 'adapter-event:output', payload: { message: 'safe' } },
        },
      ])).not.toThrow();

      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' })[0]?.event).toMatchObject({
        kind: 'output',
        metadata: { self: { type: 'circular' } },
      });
    });

    it('serializes a cyclic raw payload without losing the capture batch', () => {
      const payload: Record<string, unknown> = {};
      payload['self'] = payload;

      expect(() => store.appendProviderEventCaptures([
        {
          eventId: 'cyclic-raw-event', provider: 'claude', instanceId: 'instance-1', sessionId: null,
          sequence: 0, createdAt: 1,
          event: { kind: 'status', status: 'busy' },
          raw: { source: 'adapter-event:status', payload },
        },
      ])).not.toThrow();

      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' })[0]?.raw).toEqual({
        source: 'adapter-event:status',
        payload: { self: { type: 'circular' } },
      });
    });

    it('stores raw-backed canonical events independently of conversation threads', () => {
      store.appendProviderEventCaptures([
        {
          eventId: 'evt-1',
          provider: 'claude',
          instanceId: 'instance-1',
          sessionId: 'session-1',
          sequence: 4,
          createdAt: 100,
          event: { kind: 'output', content: 'hello' },
          raw: { source: 'adapter-event:output', payload: { nativeId: 'n-1', text: 'hello' } },
        },
      ]);

      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' })).toEqual([
        expect.objectContaining({
          eventId: 'evt-1',
          provider: 'claude',
          sequence: 4,
          event: { kind: 'output', content: 'hello' },
          raw: { source: 'adapter-event:output', payload: { nativeId: 'n-1', text: 'hello' } },
        }),
      ]);
    });

    it('prunes only captures older than the supplied retention boundary', () => {
      store.appendProviderEventCaptures([
        {
          eventId: 'old', provider: 'codex', instanceId: 'instance-1', sessionId: null,
          sequence: 0, createdAt: 10, event: { kind: 'status', status: 'busy' },
          raw: { source: 'adapter-event:status', payload: 'busy' },
        },
        {
          eventId: 'fresh', provider: 'codex', instanceId: 'instance-1', sessionId: null,
          sequence: 1, createdAt: 100, event: { kind: 'status', status: 'idle' },
          raw: { source: 'adapter-event:status', payload: 'idle' },
        },
      ]);

      expect(store.pruneProviderEventCapturesBefore(50)).toBe(1);
      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' }).map((capture) => capture.eventId))
        .toEqual(['fresh']);
    });
  });
});
