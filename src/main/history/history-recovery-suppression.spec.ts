import { describe, expect, it } from 'vitest';
import type { HistoryIndex } from '../../shared/types/history.types';
import { RECOVERY_FALLBACK_WINDOW_MS } from '../session/session-recovery-candidate-service';
import {
  isRecoverySuppressedByHistory,
  tombstoneDeletedHistoryEntry,
} from './history-recovery-suppression';

const NOW = 2_000_000_000_000;

function emptyIndex(overrides: Partial<HistoryIndex> = {}): HistoryIndex {
  return { version: 1, lastUpdated: NOW, entries: [], ...overrides };
}

describe('history recovery suppression', () => {
  it('tombstones the session id and the thread with its deletion time', () => {
    const index = emptyIndex({ deletedSessionIds: ['older-session'] });

    tombstoneDeletedHistoryEntry(index, { sessionId: ' session-1 ', historyThreadId: 'thread-1' }, NOW);

    expect(index.deletedSessionIds).toEqual(['older-session', 'session-1']);
    expect(index.deletedHistoryThreads).toEqual({ 'thread-1': NOW });
  });

  it('prunes thread tombstones older than the recovery window', () => {
    const index = emptyIndex({
      deletedHistoryThreads: {
        expired: NOW - RECOVERY_FALLBACK_WINDOW_MS - 1,
        recent: NOW - 1_000,
      },
    });

    tombstoneDeletedHistoryEntry(index, { sessionId: '', historyThreadId: 'thread-2' }, NOW);

    expect(index.deletedHistoryThreads).toEqual({ recent: NOW - 1_000, 'thread-2': NOW });
    expect(index.deletedSessionIds).toBeUndefined();
  });

  it('suppresses an autosave last active before its thread was deleted', () => {
    const index = emptyIndex({ deletedHistoryThreads: { 'thread-1': NOW } });
    const query = { provider: 'claude' as const, historyThreadId: 'thread-1' };

    expect(isRecoverySuppressedByHistory(index, { ...query, lastActivityAt: NOW - 1 })).toBe(true);
    expect(isRecoverySuppressedByHistory(index, { ...query, lastActivityAt: NOW + 1 })).toBe(false);
    expect(isRecoverySuppressedByHistory(index, {
      provider: 'claude', historyThreadId: 'other-thread', lastActivityAt: NOW - 1,
    })).toBe(false);
  });

  it('lets work done after a deletion through even though its session id is tombstoned', () => {
    const index = emptyIndex();
    tombstoneDeletedHistoryEntry(index, { sessionId: 'session-1', historyThreadId: 'thread-1' }, NOW);
    const query = { provider: 'claude' as const, historyThreadId: 'thread-1', sessionId: 'session-1' };

    expect(isRecoverySuppressedByHistory(index, { ...query, lastActivityAt: NOW - 1 })).toBe(true);
    expect(isRecoverySuppressedByHistory(index, { ...query, lastActivityAt: NOW + 1 })).toBe(false);
  });

  it('suppresses an autosave whose native session was deleted', () => {
    const index = emptyIndex({ deletedSessionIds: ['session-1'] });

    expect(isRecoverySuppressedByHistory(index, {
      provider: 'claude', sessionId: 'session-1', lastActivityAt: NOW,
    })).toBe(true);
  });

  it('suppresses autosaves last active before history was cleared', () => {
    const index = emptyIndex({ recoverySuppressedThrough: NOW });

    expect(isRecoverySuppressedByHistory(index, {
      provider: 'codex', historyThreadId: 'thread-1', lastActivityAt: NOW,
    })).toBe(true);
    expect(isRecoverySuppressedByHistory(index, {
      provider: 'codex', historyThreadId: 'thread-1', lastActivityAt: NOW + 1,
    })).toBe(false);
  });
});
