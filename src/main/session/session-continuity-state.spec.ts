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


describe('OpenCode extra folder continuity', () => {
  it('clones valid cross-platform folder roots when normalizing a persisted state', () => {
    const directories = ['/work/second', 'C:\\work\\third', '\\\\server\\share\\fourth'];
    const original = { ...state([]), provider: 'opencode' as const, additionalDirectories: directories };
    const restored = normalizeStateForContinuity(original, false);
    expect(restored.additionalDirectories).toEqual(directories);
    expect(restored.additionalDirectories).not.toBe(directories);
    restored.additionalDirectories!.push('/work/later');
    expect(original.additionalDirectories).toHaveLength(3);
  });
  it.each([null, 'relative', ['relative'], ['/work/*'], ['/work/?'], ['C:relative'], ['/bad\0root'], Array.from({ length: 65 }, () => '/work')])('refuses malformed persisted roots instead of silently dropping them: %j', (value) => {
    expect(() => normalizeStateForContinuity({ ...state([]), provider: 'opencode', additionalDirectories: value } as SessionState, false)).toThrow();
  });
  it('rejects nonempty OpenCode folder roots on another provider', () => {
    expect(() => normalizeStateForContinuity({ ...state([]), provider: 'claude', additionalDirectories: ['/work/second'] }, false)).toThrow();
    expect(normalizeStateForContinuity({ ...state([]), provider: 'claude', additionalDirectories: [] }, false).additionalDirectories).toEqual([]);
  });
});


describe('durable transcript completeness', () => {
  it('retains explicit completeness only when normalization preserves every entry', () => {
    const original = { ...state([entry({ id: 'one', content: 'kept' })]), conversationHistoryComplete: true };
    expect(normalizeStateForContinuity(original, false).conversationHistoryComplete).toBe(true);
    const redacted = { ...original, conversationHistory: [...original.conversationHistory, entry({ id: 'tool', role: 'tool', content: 'private placeholder' })] };
    const normalized = normalizeStateForContinuity(redacted, true);
    expect(normalized.conversationHistoryComplete).toBe(false);
    expect(shouldRewriteNormalizedState(redacted, normalized)).toBe(true);
    expect(normalizeStateForContinuity({ ...original, conversationHistoryComplete: undefined }, false).conversationHistoryComplete).not.toBe(true);
  });
  it('validates and clones the persisted execution machine', () => {
    const executionLocation = { type: 'remote' as const, nodeId: 'worker-placeholder' };
    const result = normalizeStateForContinuity({ ...state([]), executionLocation }, false);
    expect(result.executionLocation).toEqual(executionLocation);
    expect(result.executionLocation).not.toBe(executionLocation);
    expect(() => normalizeStateForContinuity({ ...state([]), executionLocation: { type: 'remote', nodeId: '' } }, false)).toThrow('execution location');
  });
});


it('validates and independently clones persisted version-only placement without needing extra directories', () => {
  const nodePlacement = { requiresCli: 'opencode' as const, requiresOpenCodeMajor: 2 as const, preferNodeId: 'preference-only' };
  const normalized = normalizeStateForContinuity({ ...state([]), nodePlacement }, false) as SessionState & { nodePlacement: typeof nodePlacement };
  expect(normalized.nodePlacement).toEqual(nodePlacement);
  expect(normalized.nodePlacement).not.toBe(nodePlacement);
  expect(() => normalizeStateForContinuity({ ...state([]), nodePlacement: { requiresOpenCodeMajor: 3 } } as unknown as SessionState, false)).toThrow();
});
