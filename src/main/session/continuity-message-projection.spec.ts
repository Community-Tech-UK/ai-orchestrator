import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import {
  continuityEntryToOutputMessage,
  outputMessagesToContinuityEntries,
} from './continuity-message-projection';

describe('outputMessagesToContinuityEntries', () => {
  it('correlates ACP tool calls and results through their toolCallId metadata', () => {
    // The shape the ACP adapter (Copilot, Cursor) emits: no `id`/`tool_use_id`,
    // only `toolCallId` on both halves of the pair.
    const messages: OutputMessage[] = [
      {
        id: 'call-message', timestamp: 1, type: 'tool_use', content: 'Viewing config.ts',
        metadata: { toolCallId: 'acp-call-1', name: 'view', title: 'Viewing config.ts', input: { path: 'config.ts' } },
      },
      {
        id: 'result-message', timestamp: 2, type: 'tool_result', content: 'file body',
        metadata: { sessionUpdate: 'tool_call_update', toolCallId: 'acp-call-1', status: 'completed' },
      },
    ];

    const [call, result] = outputMessagesToContinuityEntries(messages);

    expect(call.toolUse).toMatchObject({ kind: 'call', callId: 'acp-call-1', toolName: 'view' });
    expect(result.toolUse).toMatchObject({ kind: 'result', resultForCallId: 'acp-call-1', toolName: 'view' });
  });

  // LT-657: Harness-authored input must survive a restart as Harness input,
  // not come back as a user message or an anonymous system notice.
  it('round-trips Harness-authored input with its provenance and keeps user turns as user', () => {
    const messages: OutputMessage[] = [
      { id: 'u1', timestamp: 1, type: 'user', content: 'please fix the defects' },
      {
        id: 'h1', timestamp: 2, type: 'system', content: 'Automatic check-in: background work is still running.',
        metadata: { internalInput: { actor: 'harness', source: 'async-work-continuation' } },
      },
    ];

    const entries = outputMessagesToContinuityEntries(messages);
    expect(entries.map((entry) => [entry.role, entry.internalInput ?? null])).toEqual([
      ['user', null],
      ['system', { actor: 'harness', source: 'async-work-continuation' }],
    ]);

    const restored = entries.map(continuityEntryToOutputMessage);
    expect(restored.map((message) => [message.type, message.metadata?.internalInput ?? null])).toEqual([
      ['user', null],
      ['system', { actor: 'harness', source: 'async-work-continuation' }],
    ]);
  });

  it('round-trips tool traffic back into typed output messages', () => {
    const messages: OutputMessage[] = [
      {
        id: 'call-message', timestamp: 1, type: 'tool_use', content: 'Viewing config.ts',
        metadata: { toolCallId: 'acp-call-1', name: 'view', input: { path: 'config.ts' } },
      },
      {
        id: 'result-message', timestamp: 2, type: 'tool_result', content: 'file body',
        metadata: { toolCallId: 'acp-call-1' },
      },
    ];

    const restored = outputMessagesToContinuityEntries(messages).map(continuityEntryToOutputMessage);

    expect(restored.map((message) => message.type)).toEqual(['tool_use', 'tool_result']);
    expect(restored[0].metadata).toMatchObject({ id: 'acp-call-1', toolName: 'view' });
    expect(restored[1].metadata).toMatchObject({ tool_use_id: 'acp-call-1' });
  });
});
