import { describe, expect, it } from 'vitest';
import { AcpSessionReplay } from './acp-session-replay';

describe('ACP opening history transaction', () => {
  it('bounds retained metadata and session identity even without visible replay', () => {
    const replay = new AcpSessionReplay('retained', false);
    replay.observe({ sessionId: 'retained', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'x'.repeat(2 * 1024 * 1024) }] } });
    expect(() => replay.finish()).toThrow('refusing an incomplete restore');
    expect(() => new AcpSessionReplay('x'.repeat(2001), true)).toThrow('safe replay limit');
  });
  it('rejects an overflowing replay instead of publishing a truncated history', () => {
    const replay = new AcpSessionReplay('retained', true);
    for (let index = 0; index <= 10_000; index++) {
      replay.observe({ sessionId: 'retained', update: { sessionUpdate: 'user_message_chunk', messageId: `u${index}`, content: { type: 'text', text: 'hello' } } });
    }
    expect(() => replay.finish()).toThrow('refusing an incomplete restore');
  });

  it('keeps only the parent conversation and selected startup metadata', () => {
    const replay = new AcpSessionReplay('retained', true);
    const update = (value: Record<string, unknown>) => replay.observe({ sessionId: 'retained', update: value });
    expect(replay.observe({ sessionId: 'unrelated', update: { sessionUpdate: 'user_message_chunk' } })).toBe(false);
    update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'One\n' }, _meta: { privateVendorField: 'fixture private metadata' } });
    update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'two' } });
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'child', content: { type: 'text', text: 'fixture child answer' }, _meta: { 'opencode/child-session': null } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture private reasoning' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'fixture tool', rawInput: { fixture: 'raw tool input' } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] });
    const result = replay.finish();
    expect(result.history?.messages).toEqual([expect.objectContaining({ id: 'u1', type: 'user', content: 'One\ntwo', metadata: { transport: 'acp', acpReplay: true } })]);
    expect(result.metadata).toEqual([{ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] }]);
    expect(JSON.stringify(result)).not.toMatch(/private|child answer|raw tool input/);
  });
});
