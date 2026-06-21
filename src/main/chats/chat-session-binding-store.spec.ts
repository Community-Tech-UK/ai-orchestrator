import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import {
  ChatSessionBindingStore,
  evaluateLineage,
  type ChatSessionBinding,
} from './chat-session-binding-store';

describe('ChatSessionBindingStore', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function makeStore(): { store: ChatSessionBindingStore; db: SqliteDriver } {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    dbs.push(db);
    return { store: new ChatSessionBindingStore(db), db };
  }

  it('returns null for a chat with no binding row', () => {
    const { store } = makeStore();
    expect(store.get('chat-unknown')).toBeNull();
  });

  it('creates a dirty binding on first markNeedsRebuild', () => {
    const { store } = makeStore();
    store.markNeedsRebuild('chat-1');

    const binding = store.get('chat-1');
    expect(binding).toMatchObject({
      chatId: 'chat-1',
      needsRebuild: true,
      lineageEpoch: 1,
      provider: null,
      sessionId: null,
    });
  });

  it('increments the lineage epoch on each subsequent markNeedsRebuild', () => {
    const { store } = makeStore();
    store.markNeedsRebuild('chat-1');
    store.markNeedsRebuild('chat-1');
    store.markNeedsRebuild('chat-1');

    expect(store.get('chat-1')?.lineageEpoch).toBe(3);
    expect(store.get('chat-1')?.needsRebuild).toBe(true);
  });

  it('recordValidSession clears the flag, records session + tail marker, preserves epoch', () => {
    const { store } = makeStore();
    store.markNeedsRebuild('chat-1');
    store.markNeedsRebuild('chat-1');
    expect(store.get('chat-1')?.lineageEpoch).toBe(2);

    store.recordValidSession({
      chatId: 'chat-1',
      provider: 'claude',
      sessionId: 'sess-abc',
      lastTurnNativeId: 'user:42',
    });

    expect(store.get('chat-1')).toMatchObject({
      chatId: 'chat-1',
      needsRebuild: false,
      provider: 'claude',
      sessionId: 'sess-abc',
      lastTurnNativeId: 'user:42',
      // recording a valid session must NOT reset the epoch — it tracks history.
      lineageEpoch: 2,
    });
    expect(store.get('chat-1')?.lastValidatedAt).toBeTypeOf('number');
  });

  it('records provider/session even when recordValidSession runs before any markNeedsRebuild', () => {
    const { store } = makeStore();
    store.recordValidSession({
      chatId: 'chat-1',
      provider: 'codex',
      sessionId: 'rollout-1',
      lastTurnNativeId: null,
    });

    expect(store.get('chat-1')).toMatchObject({
      chatId: 'chat-1',
      needsRebuild: false,
      provider: 'codex',
      sessionId: 'rollout-1',
      lineageEpoch: 0,
    });
  });

  it('isolates bindings per chat', () => {
    const { store } = makeStore();
    store.markNeedsRebuild('chat-1');

    expect(store.get('chat-1')?.needsRebuild).toBe(true);
    expect(store.get('chat-2')).toBeNull();
  });
});

describe('evaluateLineage (§5.1)', () => {
  const validBinding: ChatSessionBinding = {
    chatId: 'chat-1',
    provider: 'claude',
    sessionId: 'sess-1',
    lineageEpoch: 0,
    needsRebuild: false,
    lastTurnNativeId: 'user:7',
    lastValidatedAt: 1,
    updatedAt: 1,
  };
  const baseCtx = {
    requestedProvider: 'claude',
    liveSessionId: 'sess-1',
    isFresh: false,
    lastTurnStillInLedger: true,
  };

  it('is valid when provider, session, epoch and ledger tail all agree', () => {
    expect(evaluateLineage(validBinding, baseCtx)).toEqual({ valid: true, reason: 'ok' });
  });

  it('a fresh instance is always invalid (new opaque session)', () => {
    expect(evaluateLineage(validBinding, { ...baseCtx, isFresh: true }))
      .toEqual({ valid: false, reason: 'fresh-session' });
  });

  it('no binding is invalid', () => {
    expect(evaluateLineage(null, baseCtx)).toEqual({ valid: false, reason: 'no-binding' });
  });

  it('needsRebuild (loop divergence) is invalid', () => {
    expect(evaluateLineage({ ...validBinding, needsRebuild: true }, baseCtx))
      .toEqual({ valid: false, reason: 'loop-divergence' });
  });

  it('a different provider is invalid', () => {
    expect(evaluateLineage(validBinding, { ...baseCtx, requestedProvider: 'codex' }))
      .toEqual({ valid: false, reason: 'provider-changed' });
  });

  it('a contradicting live session id is invalid', () => {
    expect(evaluateLineage(validBinding, { ...baseCtx, liveSessionId: 'sess-2' }))
      .toEqual({ valid: false, reason: 'session-replaced' });
  });

  it('an unknown (empty) live session id does not force a rebuild', () => {
    expect(evaluateLineage(validBinding, { ...baseCtx, liveSessionId: '' }))
      .toEqual({ valid: true, reason: 'ok' });
  });

  it('a ledger tail marker that no longer resolves is invalid', () => {
    expect(evaluateLineage(validBinding, { ...baseCtx, lastTurnStillInLedger: false }))
      .toEqual({ valid: false, reason: 'ledger-tail-mismatch' });
  });

  it('a binding with no recorded session is still valid on the tail/provider rules', () => {
    const noSession: ChatSessionBinding = { ...validBinding, sessionId: null, lastTurnNativeId: null };
    expect(evaluateLineage(noSession, { ...baseCtx, liveSessionId: 'sess-9' }))
      .toEqual({ valid: true, reason: 'ok' });
  });
});
