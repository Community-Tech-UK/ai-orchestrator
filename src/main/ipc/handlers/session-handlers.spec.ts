import { describe, it, expect } from 'vitest';
import {
  getNativeResumeSessionId,
  getMessagesForRestoreTranscript,
  selectMessagesForRestore,
} from './session-handlers';
import type { OutputMessage } from '../../../shared/types/instance.types';

function msg(type: OutputMessage['type'], index: number): OutputMessage {
  return {
    id: `msg-${index}`,
    timestamp: Date.now() + index,
    type,
    content: `Message ${index}`,
  };
}

describe('selectMessagesForRestore', () => {
  it('returns all messages when under limit', () => {
    const messages = [msg('user', 0), msg('assistant', 1)];
    const result = selectMessagesForRestore(messages, 100);
    expect(result.selected).toHaveLength(2);
    expect(result.hidden).toHaveLength(0);
    expect(result.truncatedCount).toBe(0);
  });

  it('caps at limit and returns truncated count', () => {
    const messages = Array.from({ length: 150 }, (_, i) => msg('user', i));
    const result = selectMessagesForRestore(messages, 100);
    expect(result.selected).toHaveLength(100);
    expect(result.hidden).toHaveLength(50);
    expect(result.truncatedCount).toBe(50);
  });

  it('keeps tool_use/tool_result pairs together at boundary', () => {
    const messages = [
      ...Array.from({ length: 50 }, (_, i) => msg('user', i)),
      msg('tool_result', 50),
      ...Array.from({ length: 99 }, (_, i) => msg('user', 51 + i)),
    ];
    // total = 150, limit = 100, startIdx = 50, messages[50] = tool_result
    const result = selectMessagesForRestore(messages, 100);
    expect(result.selected[0].type).not.toBe('tool_result');
    expect(result.selected.length).toBeGreaterThanOrEqual(100);
  });

  it('handles empty messages', () => {
    const result = selectMessagesForRestore([], 100);
    expect(result.selected).toHaveLength(0);
    expect(result.hidden).toHaveLength(0);
    expect(result.truncatedCount).toBe(0);
  });

  it('handles undefined messages', () => {
    const result = selectMessagesForRestore(undefined as unknown as OutputMessage[], 100);
    expect(result.selected).toHaveLength(0);
    expect(result.hidden).toHaveLength(0);
    expect(result.truncatedCount).toBe(0);
  });

  it('uses default limit of 100', () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg('user', i));
    const result = selectMessagesForRestore(messages);
    expect(result.selected).toHaveLength(100);
    expect(result.truncatedCount).toBe(100);
  });
});

describe('getMessagesForRestoreTranscript', () => {
  it('drops restore fallback notices and session-not-found errors from replay history', () => {
    const messages: OutputMessage[] = [
      {
        id: 'user-1',
        timestamp: 1,
        type: 'user',
        content: 'Continue the plan',
      },
      {
        id: 'error-1',
        timestamp: 2,
        type: 'error',
        content: 'No conversation found with session ID: stale-session',
      },
      {
        id: 'notice-1',
        timestamp: 3,
        type: 'system',
        content: 'Previous Claude CLI session could not be restored natively. Your conversation history is displayed above.',
        metadata: {
          isRestoreNotice: true,
          systemMessageKind: 'restore-fallback',
        },
      },
      {
        id: 'assistant-1',
        timestamp: 4,
        type: 'assistant',
        content: 'Back to useful context.',
      },
    ];

    expect(getMessagesForRestoreTranscript(messages)).toEqual([
      messages[0],
      messages[3],
    ]);
  });
});

describe('getNativeResumeSessionId', () => {
  it('returns the provider session id for a healthy row', () => {
    const sessionId = '66061320-7298-4d9b-9552-25f024f5e90d';
    expect(getNativeResumeSessionId({
      sessionId,
      nativeResumeFailedAt: null,
    })).toBe(sessionId);
  });

  it('does not resume once native resume has failed', () => {
    // The app-owned historyThreadId is never handed back to the provider as a
    // native resume handle; a failed row falls to replay fallback instead.
    expect(getNativeResumeSessionId({
      sessionId: '66061320-7298-4d9b-9552-25f024f5e90d',
      nativeResumeFailedAt: 123,
    })).toBeUndefined();
  });
});
