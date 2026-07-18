import { describe, it, expect } from 'vitest';
import {
  buildFallbackHistoryMessage,
  buildFreshFallbackDegradationNotice,
  buildRecoveryPacket,
  MAX_RECOVERY_MESSAGE_CHARS,
} from './fallback-history';
import type { OutputMessage } from '../../shared/types/instance.types';
import { estimateTokens } from '../../shared/utils/token-estimate';

function msg(type: OutputMessage['type'], content: string, overrides: Partial<OutputMessage> = {}): OutputMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    type,
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('buildFallbackHistoryMessage', () => {
  it('returns null for empty message list', () => {
    expect(buildFallbackHistoryMessage([], 'test', 200_000)).toBeNull();
  });

  it('includes SESSION RECOVERY header with reason', () => {
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
    const result = buildFallbackHistoryMessage(messages, 'resume-failed', 200_000);
    expect(result).toContain('[SESSION RECOVERY');
    expect(result).toContain('[STRUCTURED RECOVERY PACKET]');
    expect(result).toContain('resume-failed');
  });

  it('builds a structured recovery packet with stable message and tool metadata', () => {
    const messages = [
      msg('user', 'inspect this', { id: 'user-1' }),
      msg('tool_use', 'Read file', { id: 'tool-1', metadata: { id: 'call-1', name: 'Read' } }),
      msg('tool_result', 'File contents', { id: 'result-1', metadata: { tool_use_id: 'call-1', name: 'Read' } }),
    ];

    const packet = buildRecoveryPacket(messages, 'resume-failed');

    expect(packet).toMatchObject({
      version: 1,
      reason: 'resume-failed',
      messageCount: 3,
      completedToolCallIds: ['call-1'],
      pendingToolCallIds: [],
    });
    expect(packet.recentMessages.map((message) => message.id)).toEqual(['user-1', 'tool-1', 'result-1']);
    expect(packet.recentMessages[2]).toMatchObject({
      content: 'File contents',
      contentChars: 13,
      contentTruncated: false,
    });
  });

  it('includes all messages for short conversations within budget', () => {
    const messages = [
      msg('user', 'write tests'),
      msg('assistant', 'I will write tests'),
      msg('user', 'thanks'),
      msg('assistant', 'done'),
    ];
    const result = buildFallbackHistoryMessage(messages, 'test', 200_000)!;
    expect(result).toContain('[USER]');
    expect(result).toContain('write tests');
    expect(result).toContain('done');
  });

  it('always truncates tool outputs while preserving their original size', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(msg('user', `question ${i}`));
      messages.push(msg('assistant', `answer ${i}`));
      messages.push(msg('tool_result', 'x'.repeat(500), {
        metadata: { name: 'Read', tool_use_id: `tool-${i}` },
      }));
    }
    const result = buildFallbackHistoryMessage(messages, 'test', 200_000)!;
    expect(result).toContain('output truncated');
    expect(result).not.toContain('x'.repeat(500));
  });

  it('summarizes short tool results in replay prose', () => {
    const messages = [
      msg('user', 'inspect the file'),
      msg('tool_result', 'short but potentially stale output', {
        metadata: { name: 'Read', tool_use_id: 'tool-1' },
      }),
      msg('assistant', 'inspection complete'),
    ];

    const result = buildFallbackHistoryMessage(messages, 'test', 200_000)!;
    const history = result.split('--- Conversation History ---')[1];

    expect(history).toContain('tool output omitted from replay');
    expect(history).not.toContain('short but potentially stale output');
  });

  it('bounds a recent tool result larger than the Codex per-turn limit', () => {
    const hugeToolResult = 'x'.repeat(1_100_000);
    const messages = [
      msg('user', 'recover this session', { id: 'user-1' }),
      msg('tool_use', 'Running broad search', {
        id: 'tool-1',
        metadata: { id: 'call-1', name: 'Bash' },
      }),
      msg('tool_result', hugeToolResult, {
        id: 'result-1',
        metadata: { tool_use_id: 'call-1', name: 'Bash' },
      }),
      msg('assistant', 'I found the handoff', { id: 'assistant-1' }),
    ];
    const notice = buildFreshFallbackDegradationNotice('resume-failed-fallback');

    const packet = buildRecoveryPacket(messages, 'resume-failed-fallback');
    const result = buildFallbackHistoryMessage(
      messages,
      'resume-failed-fallback',
      258_400,
      0.3,
      notice,
    )!;

    expect(packet.recentMessages[2]).toMatchObject({
      contentChars: hugeToolResult.length,
      contentTruncated: true,
    });
    expect(packet.recentMessages[2].content.length).toBeLessThan(200);
    expect(result.length).toBeLessThanOrEqual(MAX_RECOVERY_MESSAGE_CHARS);
    expect(result).not.toContain(hugeToolResult);
    expect(result).toContain('[SESSION DEGRADATION NOTICE]');
  });

  it('shrinks to fit within budget', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(msg('user', `long question ${i} ${'x'.repeat(200)}`));
      messages.push(msg('assistant', `long answer ${i} ${'y'.repeat(200)}`));
    }
    const result = buildFallbackHistoryMessage(messages, 'test', 4_000)!;
    expect(result).not.toBeNull();
    expect(estimateTokens(result)).toBeLessThanOrEqual(1_200);
    expect(result).toContain('replay was reduced to fit provider limits');
  });

  it('returns bounded minimal recovery context under a tight budget', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(msg('user', `q${i} ${'z'.repeat(100)}`));
      messages.push(msg('assistant', `a${i} ${'z'.repeat(100)}`));
    }
    const result = buildFallbackHistoryMessage(messages, 'test', 500)!;
    expect(result).not.toBeNull();
    expect(estimateTokens(result)).toBeLessThanOrEqual(150);
    expect(result).toContain('[USER]');
  });
});

describe('buildFreshFallbackDegradationNotice', () => {
  it('states that a new session started and background work was lost', () => {
    const notice = buildFreshFallbackDegradationNotice('resume-failed-fallback');

    expect(notice).toContain('[SESSION DEGRADATION NOTICE]');
    expect(notice).toContain('resume-failed-fallback');
    expect(notice).toContain('NOT carried over');
    expect(notice).toContain('Re-establish the current state');
    expect(notice).toContain('[END SESSION DEGRADATION NOTICE]');
  });

  it('omits child sections when no orchestration children are tracked', () => {
    const notice = buildFreshFallbackDegradationNotice('resume-failed-fallback');

    expect(notice).not.toContain('child instances still alive');
    expect(notice).not.toContain('lost in the restart');
  });

  it('lists live orchestration children by id, name, and status', () => {
    const notice = buildFreshFallbackDegradationNotice('resume-failed-fallback', {
      activeChildren: [
        { id: 'child-1', name: 'researcher', status: 'busy' },
        { id: 'child-2' },
      ],
    });

    expect(notice).toContain('still alive and attached to you');
    expect(notice).toContain('- child-1 (researcher, busy)');
    expect(notice).toContain('- child-2');
    expect(notice).not.toContain('child-2 (');
  });

  it('lists dropped children lost in the restart', () => {
    const notice = buildFreshFallbackDegradationNotice('resume-failed-fallback', {
      droppedChildIds: ['dead-1', 'dead-2'],
    });

    expect(notice).toContain('lost in the restart (no longer running): dead-1, dead-2');
  });
});
