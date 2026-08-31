import { describe, expect, it } from 'vitest';
import type { ConversationData, ConversationHistoryEntry } from '../../shared/types/history.types';
import { resolveHistoryRecoveryCoverage } from './history-recovery-coverage';

function entry(overrides: Partial<ConversationHistoryEntry>): ConversationHistoryEntry {
  return {
    id: 'entry-placeholder',
    displayName: 'Coverage fixture',
    createdAt: 100,
    endedAt: 200,
    historyThreadId: 'thread-placeholder',
    workingDirectory: '/tmp/project',
    messageCount: 1,
    firstUserMessage: 'fixture first',
    lastUserMessage: 'fixture last',
    status: 'completed',
    originalInstanceId: 'instance-placeholder',
    parentId: null,
    sessionId: 'session-placeholder',
    provider: 'claude',
    ...overrides,
  };
}

function conversation(
  entryFixture: ConversationHistoryEntry,
  timestamps: readonly number[],
): ConversationData {
  return {
    entry: entryFixture,
    messages: timestamps.map((timestamp, index) => ({
      id: `message-${entryFixture.id}-${index}`,
      type: index % 2 === 0 ? 'user' : 'assistant',
      content: `fixture message ${index}`,
      timestamp,
    })),
  };
}

describe('resolveHistoryRecoveryCoverage', () => {
  it('does not synthesize coverage from index metadata when conversation data is missing', async () => {
    const indexed = entry({
      id: 'entry-unreadable',
      endedAt: 900,
      messageCount: 99,
    });

    const coverage = await resolveHistoryRecoveryCoverage(
      [indexed],
      [{
        recoveryKey: 'history:claude:thread-placeholder',
        provider: 'claude',
        historyThreadId: 'thread-placeholder',
      }],
      async () => null,
    );

    expect(coverage.has('history:claude:thread-placeholder')).toBe(false);
  });

  it('does not synthesize coverage when loading corrupt conversation data fails', async () => {
    const indexed = entry({
      id: 'entry-corrupt',
      endedAt: 900,
      messageCount: 99,
    });

    const coverage = await resolveHistoryRecoveryCoverage(
      [indexed],
      [{
        recoveryKey: 'history:claude:thread-placeholder',
        provider: 'claude',
        historyThreadId: 'thread-placeholder',
      }],
      async () => { throw new Error('corrupt conversation placeholder'); },
    );

    expect(coverage.has('history:claude:thread-placeholder')).toBe(false);
  });

  it('uses loaded transcript count and persisted timestamps instead of overstated index metadata', async () => {
    const indexed = entry({
      id: 'entry-overstated-index',
      endedAt: 900,
      messageCount: 99,
    });
    const persisted = entry({
      id: indexed.id,
      endedAt: 250,
      messageCount: 99,
    });

    const coverage = await resolveHistoryRecoveryCoverage(
      [indexed],
      [{
        recoveryKey: 'history:claude:thread-placeholder',
        provider: 'claude',
        historyThreadId: 'thread-placeholder',
      }],
      async () => conversation(persisted, [100, 200]),
    );

    expect(coverage.get('history:claude:thread-placeholder')).toEqual({
      recoveryKey: 'history:claude:thread-placeholder',
      historyEntryId: indexed.id,
      provider: 'claude',
      historyThreadId: 'thread-placeholder',
      sessionId: 'session-placeholder',
      coveredThrough: 250,
      messageCount: 2,
    });
  });

  it('rejects loaded data whose persisted identity does not match the request', async () => {
    const indexed = entry({ id: 'entry-mismatched-persisted' });
    const persisted = entry({
      id: indexed.id,
      historyThreadId: 'thread-other',
    });

    const coverage = await resolveHistoryRecoveryCoverage(
      [indexed],
      [{
        recoveryKey: 'history:claude:thread-placeholder',
        provider: 'claude',
        historyThreadId: 'thread-placeholder',
      }],
      async () => conversation(persisted, [200]),
    );

    expect(coverage.has('history:claude:thread-placeholder')).toBe(false);
  });

  it('does not fall back to a same-session entry when a history thread is requested', async () => {
    const requested = entry({
      id: 'entry-requested-thread',
      historyThreadId: 'thread-requested',
      sessionId: 'session-shared',
      endedAt: 150,
      messageCount: 1,
    });
    const conflicting = entry({
      id: 'entry-conflicting-thread',
      historyThreadId: 'thread-conflicting',
      sessionId: 'session-shared',
      endedAt: 900,
      messageCount: 3,
    });
    const conversations = new Map([
      [requested.id, conversation(requested, [150])],
      [conflicting.id, conversation(conflicting, [900, 901, 902])],
    ]);

    const coverage = await resolveHistoryRecoveryCoverage(
      [conflicting, requested],
      [{
        recoveryKey: 'history:claude:thread-requested',
        provider: 'claude',
        historyThreadId: 'thread-requested',
        sessionId: 'session-shared',
      }],
      async (entryId) => conversations.get(entryId) ?? null,
    );

    expect(coverage.get('history:claude:thread-requested')).toEqual({
      recoveryKey: 'history:claude:thread-requested',
      historyEntryId: 'entry-requested-thread',
      provider: 'claude',
      historyThreadId: 'thread-requested',
      sessionId: 'session-shared',
      coveredThrough: 150,
      messageCount: 1,
    });
  });

  it('uses session matching when the requested identity has no history thread', async () => {
    const sessionOnly = entry({
      id: 'entry-session-only',
      historyThreadId: 'thread-from-entry',
      sessionId: 'session-requested',
      endedAt: 400,
      messageCount: 2,
    });

    const coverage = await resolveHistoryRecoveryCoverage(
      [sessionOnly],
      [{
        recoveryKey: 'session:claude:session-requested',
        provider: 'claude',
        sessionId: 'session-requested',
      }],
      async (entryId) => entryId === sessionOnly.id
        ? conversation(sessionOnly, [300, 400])
        : null,
    );

    expect(coverage.get('session:claude:session-requested')).toEqual({
      recoveryKey: 'session:claude:session-requested',
      historyEntryId: 'entry-session-only',
      provider: 'claude',
      historyThreadId: 'thread-from-entry',
      sessionId: 'session-requested',
      coveredThrough: 400,
      messageCount: 2,
    });
  });
});
