import { describe, it, expect } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { ConversationHistoryEntry } from '../../shared/types/history.types';
import {
  isRestoreInfrastructureMessage,
  selectMessagesForRestore,
  getMessagesForRestoreTranscript,
  getNativeResumeSessionId,
  getProviderDisplayName,
} from './history-restore-helpers';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<OutputMessage> = {}): OutputMessage {
  return {
    id: 'msg-1',
    type: 'assistant',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ConversationHistoryEntry> = {}): Pick<
  ConversationHistoryEntry,
  'sessionId' | 'historyThreadId' | 'nativeResumeFailedAt'
> {
  return {
    sessionId: null,
    historyThreadId: null,
    nativeResumeFailedAt: null,
    ...overrides,
  };
}

// ── isRestoreInfrastructureMessage ────────────────────────────────────────────

describe('isRestoreInfrastructureMessage', () => {
  it('returns false for normal assistant messages', () => {
    expect(isRestoreInfrastructureMessage(makeMsg())).toBe(false);
  });

  it('returns true for error messages matching session-not-found patterns', () => {
    expect(
      isRestoreInfrastructureMessage(makeMsg({ type: 'error', content: 'session not found' })),
    ).toBe(true);
    expect(
      isRestoreInfrastructureMessage(makeMsg({ type: 'error', content: 'No conversation found' })),
    ).toBe(true);
  });

  it('returns false for non-session-not-found error messages', () => {
    expect(
      isRestoreInfrastructureMessage(makeMsg({ type: 'error', content: 'Network timeout' })),
    ).toBe(false);
  });

  it('returns true when metadata.isRestoreNotice is true', () => {
    expect(
      isRestoreInfrastructureMessage(makeMsg({ metadata: { isRestoreNotice: true } })),
    ).toBe(true);
  });

  it('returns true when metadata.systemMessageKind is restore-fallback', () => {
    expect(
      isRestoreInfrastructureMessage(makeMsg({ metadata: { systemMessageKind: 'restore-fallback' } })),
    ).toBe(true);
  });

  it('returns true for system message matching restore-fallback notice text', () => {
    expect(
      isRestoreInfrastructureMessage(
        makeMsg({ type: 'system', content: 'Previous Claude CLI session could not be restored natively.' }),
      ),
    ).toBe(true);
  });
});

// ── selectMessagesForRestore ──────────────────────────────────────────────────

describe('selectMessagesForRestore', () => {
  it('returns all messages when under the limit', () => {
    const msgs = [makeMsg({ id: '1' }), makeMsg({ id: '2' })];
    const result = selectMessagesForRestore(msgs, 100);
    expect(result.selected).toHaveLength(2);
    expect(result.hidden).toHaveLength(0);
    expect(result.truncatedCount).toBe(0);
  });

  it('limits to the most recent messages', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg({ id: String(i) }));
    const result = selectMessagesForRestore(msgs, 5);
    expect(result.selected).toHaveLength(5);
    expect(result.hidden).toHaveLength(5);
    expect(result.truncatedCount).toBe(5);
  });

  it('handles empty input', () => {
    const result = selectMessagesForRestore([]);
    expect(result.selected).toHaveLength(0);
    expect(result.truncatedCount).toBe(0);
  });

  it('does not split a tool_result from its preceding messages', () => {
    const msgs = [
      makeMsg({ id: '1', type: 'assistant' }),
      makeMsg({ id: '2', type: 'tool_use' }),
      makeMsg({ id: '3', type: 'tool_result' }),
      makeMsg({ id: '4', type: 'assistant' }),
      makeMsg({ id: '5', type: 'assistant' }),
    ];
    // limit=4 naively would start at index 1 (tool_use), but index 2 is tool_result,
    // so startIdx is walked back until it's not a tool_result boundary.
    const result = selectMessagesForRestore(msgs, 4);
    // startIdx walks back from 1 (not tool_result): stays at 1
    expect(result.selected[0]?.id).toBe('2');
  });
});

// ── getMessagesForRestoreTranscript ───────────────────────────────────────────

describe('getMessagesForRestoreTranscript', () => {
  it('filters out infrastructure messages', () => {
    const msgs = [
      makeMsg({ id: '1' }),
      makeMsg({ id: '2', type: 'error', content: 'session not found' }),
      makeMsg({ id: '3', content: 'hello world' }),
    ];
    const result = getMessagesForRestoreTranscript(msgs);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(['1', '3']);
  });

  it('handles empty input', () => {
    expect(getMessagesForRestoreTranscript([])).toHaveLength(0);
  });
});

// ── getNativeResumeSessionId ──────────────────────────────────────────────────

describe('getNativeResumeSessionId', () => {
  it('returns sessionId when nativeResumeFailedAt is null', () => {
    const entry = makeEntry({ sessionId: 'sess-abc', nativeResumeFailedAt: null });
    expect(getNativeResumeSessionId(entry, [], 'claude')).toBe('sess-abc');
  });

  it('returns historyThreadId when no sessionId but historyThreadId set', () => {
    const entry = makeEntry({ historyThreadId: 'thread-xyz', nativeResumeFailedAt: null });
    expect(getNativeResumeSessionId(entry, [], 'claude')).toBe('thread-xyz');
  });

  it('returns undefined when nativeResumeFailedAt is set and historyThreadId equals sessionId', () => {
    const entry = makeEntry({
      sessionId: 'same-id',
      historyThreadId: 'same-id',
      nativeResumeFailedAt: 1000,
    });
    expect(getNativeResumeSessionId(entry, [], 'claude')).toBeUndefined();
  });

  it('returns undefined when historyThreadId is in the failed set (uuid)', () => {
    // UUID format required for claude provider
    const uuid = 'a1b2c3d4-e5f6-1789-abcd-ef0123456789';
    const entry = makeEntry({
      sessionId: 'other-id',
      historyThreadId: uuid,
      nativeResumeFailedAt: 1000,
    });
    const failedMsg = makeMsg({
      type: 'error',
      content: `session not found for session id: ${uuid}`,
    });
    expect(getNativeResumeSessionId(entry, [failedMsg], 'claude')).toBeUndefined();
  });

  it('returns historyThreadId when it is a valid UUID and not in the failed set', () => {
    const uuid = 'a1b2c3d4-e5f6-1789-abcd-ef0123456789';
    const entry = makeEntry({
      sessionId: 'other-id',
      historyThreadId: uuid,
      nativeResumeFailedAt: 1000,
    });
    // No failed messages
    expect(getNativeResumeSessionId(entry, [], 'claude')).toBe(uuid);
  });

  it('returns undefined for non-claude provider when nativeResumeFailedAt is set', () => {
    const uuid = 'a1b2c3d4-e5f6-1789-abcd-ef0123456789';
    const entry = makeEntry({
      sessionId: 'other-id',
      historyThreadId: uuid,
      nativeResumeFailedAt: 1000,
    });
    expect(getNativeResumeSessionId(entry, [], 'gemini')).toBeUndefined();
  });
});

// ── getProviderDisplayName ────────────────────────────────────────────────────

describe('getProviderDisplayName', () => {
  it.each([
    ['claude', 'Claude'],
    ['gemini', 'Gemini'],
    ['codex', 'Codex'],
    ['copilot', 'Copilot'],
    ['cursor', 'Cursor'],
  ] as const)('returns correct display name for %s', (provider, expected) => {
    expect(getProviderDisplayName(provider)).toBe(expected);
  });
});
