import { describe, expect, it } from 'vitest';
import type { ConversationHistoryEntry } from '../../shared/types/history.types';
import { isSameHistoryEntryForIdentityBackfill } from './history-identity-backfill';

function entry(
  overrides: Partial<ConversationHistoryEntry> = {},
): ConversationHistoryEntry {
  return {
    id: 'entry-a',
    displayName: 'Legacy identity fixture',
    createdAt: 100,
    endedAt: 200,
    historyThreadId: 'session-a',
    workingDirectory: '/tmp/history-identity-backfill',
    messageCount: 2,
    firstUserMessage: 'Placeholder prompt',
    lastUserMessage: 'Placeholder prompt',
    status: 'completed',
    originalInstanceId: 'instance-a',
    parentId: null,
    sessionId: 'session-a',
    provider: 'claude',
    ...overrides,
  };
}

describe('isSameHistoryEntryForIdentityBackfill', () => {
  it('accepts the same indexed and persisted legacy record', () => {
    expect(isSameHistoryEntryForIdentityBackfill(entry(), entry())).toBe(true);
  });

  it.each([
    ['entry ID', { id: 'entry-b' }],
    ['provider', { provider: 'gemini' }],
    ['session identity', { sessionId: 'session-b', historyThreadId: 'session-b' }],
  ] as const)('rejects a mismatched %s', (_field, persistedOverrides) => {
    expect(isSameHistoryEntryForIdentityBackfill(entry(), entry(persistedOverrides))).toBe(false);
  });

  it('rejects records without a provable session identity', () => {
    expect(isSameHistoryEntryForIdentityBackfill(
      entry({ sessionId: '', historyThreadId: undefined }),
      entry({ sessionId: '', historyThreadId: undefined }),
    )).toBe(false);
  });
});
