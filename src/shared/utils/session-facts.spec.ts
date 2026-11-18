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

  it('counts one compaction once when the provider row and the app divider both record it', () => {
    const system = (id: string, timestamp: number, metadata: Record<string, unknown>): OutputMessage => ({ id, type: 'system', timestamp, metadata, content: '' });
    const user: OutputMessage = { id: 'u', type: 'user', timestamp: 3000, metadata: {}, content: 'next' };
    const providerRow = (id: string, t: number) => system(id, t, { threadCompacted: true, isCompactionBoundary: true, method: 'self-managed', compactionMarkerId: `p-${id}` });
    const divider = (id: string, t: number) => system(id, t, { isCompactionBoundary: true, method: 'native', compactionMarkerId: `d-${id}` });
    const restoredProviderRow = system('rp', 1, { isCompactionBoundary: true, method: 'self-managed', compactionMarkerId: 'rp' });
    // One compaction: provider row, its finish notice, then the app divider.
    expect(sessionFacts([providerRow('a', 1), system('n', 2, { providerCompaction: 'completed' }), divider('b', 3)]).compactions).toBe(1);
    // Restored from continuity (threadCompacted is gone, method stays).
    expect(sessionFacts([restoredProviderRow, divider('b', 3)]).compactions).toBe(1);
    // Provider-only (automatic) and app-only compactions each count once.
    expect(sessionFacts([providerRow('a', 1)]).compactions).toBe(1);
    expect(sessionFacts([divider('b', 1)]).compactions).toBe(1);
    // A later app compaction after conversation is a new one, not the earlier provider row's divider.
    expect(sessionFacts([providerRow('a', 1), user, divider('b', 4)]).compactions).toBe(2);
    // Two real compactions in a row still count twice.
    expect(sessionFacts([providerRow('a', 1), divider('b', 2), providerRow('c', 3), divider('d', 4)]).compactions).toBe(2);
  });

  it('counts a command the provider reports as failed even when is_error is false, once per result', () => {
    const message = (id: string, type: OutputMessage['type'], timestamp: number, metadata: Record<string, unknown>): OutputMessage => ({ id, type, timestamp, metadata, content: '' });
    const facts = sessionFacts([
      message('c1', 'tool_use', 10, { id: 'ok', name: 'Bash' }),
      message('r1', 'tool_result', 20, { id: 'ok', status: 'completed', is_error: false, exitCode: 0 }),
      message('c2', 'tool_use', 30, { id: 'bad', name: 'Bash' }),
      message('r2', 'tool_result', 40, { id: 'bad', status: 'failed', is_error: false, exitCode: 1 }),
      message('c3', 'tool_use', 50, { id: 'both', name: 'Bash' }),
      message('r3', 'tool_result', 60, { id: 'both', status: 'failed', is_error: true }),
    ]);
    expect(facts.failed).toBe(2);
  });
});
