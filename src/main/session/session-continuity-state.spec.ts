import { describe, expect, it } from 'vitest';
import type { ConversationEntry, SessionState } from './session-continuity.types';
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  findLastIndexById,
  getStateLookupKeys,
  migrateSessionState,
  normalizeConversationHistory,
  normalizeLookupIdentifier,
  normalizeStateForContinuity,
  shouldRewriteNormalizedState,
} from './session-continuity-state';

function entry(partial: Partial<ConversationEntry> & Pick<ConversationEntry, 'id' | 'content'>): ConversationEntry {
  return {
    role: 'assistant',
    timestamp: 1,
    ...partial,
  };
}

function state(history: ConversationEntry[]): SessionState {
  return {
    instanceId: 'inst-1',
    conversationHistory: history,
  } as SessionState;
}

describe('session-continuity-state', () => {
  it('migrates schemaVersion 1 to 2', () => {
    expect(migrateSessionState({ foo: 1 })).toEqual({
      foo: 1,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    });
  });

  it('finds the last matching id', () => {
    const entries = [
      entry({ id: 'a', content: '1' }),
      entry({ id: 'b', content: '2' }),
      entry({ id: 'a', content: '3' }),
    ];
    expect(findLastIndexById(entries, 'a')).toBe(2);
    expect(findLastIndexById(entries, 'missing')).toBe(-1);
  });

  it('builds lookup keys from identity fields', () => {
    expect(getStateLookupKeys({
      instanceId: ' inst-1 ',
      historyThreadId: 'thread-1',
      sessionId: '',
    })).toEqual(['inst-1', 'thread-1']);
    expect(normalizeLookupIdentifier('  ')).toBeNull();
  });

  it('dedupes conversation entries by id and drops redacted tool output', () => {
    const history = normalizeConversationHistory(
      [
        entry({ id: 'a', content: 'old' }),
        entry({ id: 'a', content: 'new' }),
        entry({ id: 'b', role: 'tool', content: '[REDACTED TOOL OUTPUT]' }),
        { id: '', role: 'user', content: 'anon', timestamp: 2 },
      ],
      false,
    );
    expect(history.map((item) => item.content)).toEqual(['new', 'anon']);
  });

  it('detects when a normalized rewrite is required', () => {
    const original = state([entry({ id: 'a', content: 'old' })]);
    const same = normalizeStateForContinuity(original, false);
    expect(shouldRewriteNormalizedState(original, same)).toBe(false);
    expect(shouldRewriteNormalizedState(
      original,
      state([entry({ id: 'a', content: 'new' })]),
    )).toBe(true);
  });
});
