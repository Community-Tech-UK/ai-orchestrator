import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import {
  observeAdapterRuntimeEvents,
  type NormalizedAdapterRuntimeEvent,
} from './adapter-runtime-event-bridge';

describe('observeAdapterRuntimeEvents', () => {
  it('normalizes raw adapter events into provider runtime events', () => {
    const adapter = new EventEmitter();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    adapter.emit('output', {
      id: 'msg-1',
      timestamp: 123,
      type: 'assistant',
      content: 'hello',
    });
    adapter.emit('output', 'plain text');
    adapter.emit('tool_use', {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
    });
    adapter.emit('tool_result', {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
      result: 'ok',
    });
    adapter.emit('status', 'idle');
    adapter.emit('context', { used: 10, total: 100, percentage: 10, cumulativeTokens: 20, isEstimated: true });
    adapter.emit('error', new Error('boom'));
    adapter.emit('complete', {
      usage: { totalTokens: 42, cost: 0.25, duration: 500 },
    });
    adapter.emit('spawned', 321);
    adapter.emit('exit', 0, null);

    expect(events.map(({ event }) => event.kind)).toEqual([
      'output',
      'output',
      'tool_use',
      'tool_result',
      'status',
      'context',
      'error',
      'complete',
      'spawned',
      'exit',
    ]);

    expect(events[0]).toMatchObject({
      timestamp: 123,
      event: {
        kind: 'output',
        content: 'hello',
        messageType: 'assistant',
        messageId: 'msg-1',
        timestamp: 123,
      },
    });
    expect(events[1]?.event).toMatchObject({
      kind: 'output',
      content: 'plain text',
      messageType: 'assistant',
    });
    expect(events[2]?.event).toEqual({
      kind: 'tool_use',
      toolName: 'Read',
      toolUseId: 'tool-1',
      input: { path: 'README.md' },
    });
    expect(events[3]?.event).toEqual({
      kind: 'tool_result',
      toolName: 'Read',
      toolUseId: 'tool-1',
      success: true,
      output: 'ok',
    });
    expect(events[5]?.event).toEqual({
      kind: 'context',
      used: 10,
      total: 100,
      percentage: 10,
    });
    expect(events[5]?.rawPayload).toEqual({
      used: 10,
      total: 100,
      percentage: 10,
      cumulativeTokens: 20,
      isEstimated: true,
    });
    expect(events[7]?.event).toEqual({
      kind: 'complete',
      tokensUsed: 42,
      costUsd: 0.25,
      durationMs: 500,
    });
  });

  it('removes listeners when cleanup is called', () => {
    const adapter = new EventEmitter();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    const cleanup = observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    cleanup();
    adapter.emit('status', 'idle');

    expect(events).toHaveLength(0);
  });
});
