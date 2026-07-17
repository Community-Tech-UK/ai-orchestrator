import { describe, expect, it } from 'vitest';
import { mapCopilotServerEvent } from './copilot-server-event-mapper';

/**
 * Fixture corpus mirroring @github/copilot 1.0.x `session-events.d.ts` shapes
 * (WS1 mapper pattern: shapes captured as data, mapper stays pure).
 */
describe('mapCopilotServerEvent', () => {
  it('maps assistant deltas with their message id', () => {
    expect(
      mapCopilotServerEvent({
        type: 'assistant.message_delta',
        data: { deltaContent: 'Hel', messageId: 'm-1' },
      }),
    ).toEqual({ kind: 'assistant-delta', messageId: 'm-1', delta: 'Hel' });
  });

  it('maps the final assistant message with output tokens', () => {
    expect(
      mapCopilotServerEvent({
        type: 'assistant.message',
        data: { content: 'Hello!', messageId: 'm-1', outputTokens: 12 },
      }),
    ).toEqual({ kind: 'assistant-message', messageId: 'm-1', content: 'Hello!', outputTokens: 12 });
  });

  it('maps reasoning, tool start and tool completion (success and failure)', () => {
    expect(
      mapCopilotServerEvent({ type: 'assistant.reasoning', data: { content: 'thinking…' } }),
    ).toEqual({ kind: 'reasoning', content: 'thinking…' });

    expect(
      mapCopilotServerEvent({
        type: 'tool.execution_start',
        data: { toolName: 'bash', toolCallId: 't-1', arguments: { cmd: 'ls' } },
      }),
    ).toEqual({ kind: 'tool-start', toolName: 'bash', toolCallId: 't-1', args: { cmd: 'ls' } });

    expect(
      mapCopilotServerEvent({
        type: 'tool.execution_complete',
        data: { toolCallId: 't-1', toolName: 'bash', success: true, result: { content: 'ok' } },
      }),
    ).toMatchObject({ kind: 'tool-complete', toolCallId: 't-1', success: true });

    expect(
      mapCopilotServerEvent({
        type: 'tool.execution_complete',
        data: { toolCallId: 't-2', success: false, error: { message: 'denied' } },
      }),
    ).toMatchObject({ kind: 'tool-complete', success: false, errorMessage: 'denied' });
  });

  it('maps session.usage_info to REAL context occupancy', () => {
    expect(
      mapCopilotServerEvent({
        type: 'session.usage_info',
        data: { currentTokens: 12_000, tokenLimit: 128_000, messagesLength: 4 },
      }),
    ).toEqual({ kind: 'context', used: 12_000, total: 128_000 });
    // Missing/invalid limits never fabricate a context reading.
    expect(
      mapCopilotServerEvent({ type: 'session.usage_info', data: { currentTokens: 5 } }),
    ).toEqual({ kind: 'ignored', type: 'session.usage_info' });
  });

  it('maps session errors with type/code passthrough', () => {
    expect(
      mapCopilotServerEvent({
        type: 'session.error',
        data: { message: 'weekly limit', errorType: 'rate_limit', errorCode: 'user_weekly_rate_limited' },
      }),
    ).toEqual({
      kind: 'session-error',
      message: 'weekly limit',
      errorType: 'rate_limit',
      errorCode: 'user_weekly_rate_limited',
    });
  });

  it('maps turn/idle lifecycle events', () => {
    expect(mapCopilotServerEvent({ type: 'assistant.turn_start' })).toEqual({ kind: 'turn-start' });
    expect(mapCopilotServerEvent({ type: 'assistant.turn_end' })).toEqual({ kind: 'turn-end' });
    expect(mapCopilotServerEvent({ type: 'session.idle' })).toEqual({ kind: 'idle' });
  });

  it('skips sub-agent events entirely (root transcript only)', () => {
    expect(
      mapCopilotServerEvent({
        type: 'assistant.message_delta',
        agentId: 'sub-1',
        data: { deltaContent: 'noise', messageId: 'm-9' },
      }),
    ).toEqual({ kind: 'ignored', type: 'assistant.message_delta' });
  });

  it('ignores unknown event types and malformed payloads without throwing', () => {
    expect(mapCopilotServerEvent({ type: 'session.plan_changed', data: {} })).toEqual({
      kind: 'ignored',
      type: 'session.plan_changed',
    });
    expect(mapCopilotServerEvent({ type: 'assistant.message', data: { messageId: 'm-1' } })).toEqual(
      { kind: 'ignored', type: 'assistant.message' },
    );
    expect(mapCopilotServerEvent({ type: 'assistant.message_delta' })).toEqual({
      kind: 'ignored',
      type: 'assistant.message_delta',
    });
  });
});
