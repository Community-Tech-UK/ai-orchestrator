import { describe, it, expect } from 'vitest';
import { buildFallbackHistoryMessage, buildRecoveryPacket } from './fallback-history';
import type { OutputMessage } from '../../shared/types/instance.types';

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

  it('truncates tool outputs older than last 5 turns', () => {
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
    expect(result).toContain('x'.repeat(500));
  });

  it('shrinks to fit within budget', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(msg('user', `long question ${i} ${'x'.repeat(200)}`));
      messages.push(msg('assistant', `long answer ${i} ${'y'.repeat(200)}`));
    }
    const result = buildFallbackHistoryMessage(messages, 'test', 4_000)!;
    expect(result).not.toBeNull();
    expect(result.length / 4).toBeLessThanOrEqual(4_000);
    expect(result).toContain('exchanges');
  });

  it('preserves minimum of 3 turns even under tight budget', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(msg('user', `q${i} ${'z'.repeat(100)}`));
      messages.push(msg('assistant', `a${i} ${'z'.repeat(100)}`));
    }
    const result = buildFallbackHistoryMessage(messages, 'test', 500)!;
    expect(result).not.toBeNull();
    expect(result).toContain('[USER]');
  });
});
