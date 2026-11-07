import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../types/instance.types';
import { sessionFacts } from './session-facts';
import { continuityEntryToOutputMessage } from '../../main/session/continuity-message-projection';

describe('session facts from recorded messages', () => {
  it('uses the recorded tool name after a conversation is restored from continuity', () => {
    const call = continuityEntryToOutputMessage({ id: 'call', role: 'assistant', content: '', timestamp: 10,
      toolUse: { kind: 'call', toolName: 'Read', input: null, callId: 'restored' } });
    const result = continuityEntryToOutputMessage({ id: 'result', role: 'tool', content: '', timestamp: 1010,
      toolUse: { kind: 'result', toolName: 'Read', input: null, resultForCallId: 'restored' } });
    expect(sessionFacts([call, result]).slowest).toEqual([{ id: 'restored', name: 'Read', durationMs: 1000 }]);
  });

  it('pairs tools by identity, counts explicit failures and never guesses a result for missing ids', () => {
    const message = (id: string, type: OutputMessage['type'], timestamp: number, metadata: Record<string, unknown>): OutputMessage => ({ id, type, timestamp, metadata, content: '' });
    const facts = sessionFacts([
      message('call', 'tool_use', 10, { id: 'a', name: 'Read' }),
      message('other', 'tool_use', 20, { toolCallId: 'b', name: 'Bash' }),
      message('result', 'tool_result', 1010, { tool_use_id: 'a', is_error: true }),
      message('duplicate', 'tool_result', 1011, { tool_use_id: 'a', is_error: true }),
      message('unknown', 'tool_use', 25, { name: 'Write' }),
      message('boundary', 'system', 2000, { isCompactionBoundary: true }),
    ]);
    expect(facts.failed).toBe(1);
    expect(facts.withoutRecordedResult.map(tool => tool.name)).toEqual(['Bash']);
    expect(facts.slowest).toEqual([{ id: 'a', name: 'Read', durationMs: 1000 }]);
    expect(facts.unmatchedIdentity).toBe(1);
    expect(facts.compactions).toBe(1);
  });
});
