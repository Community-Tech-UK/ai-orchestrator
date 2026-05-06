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

  it('normalizes provider diagnostics from context and complete payloads', () => {
    const adapter = new EventEmitter();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    adapter.emit('context', {
      used: 80,
      total: 100,
      percentage: 80,
      inputTokens: 60,
      outputTokens: 20,
      source: 'provider-usage',
      promptWeight: 0.75,
      promptWeightBreakdown: {
        systemPrompt: 25,
        mcpToolDescriptions: 15,
        skills: 10,
        userPrompt: 10,
      },
    });
    adapter.emit('complete', {
      usage: { totalTokens: 80, duration: 900 },
      metadata: {
        requestId: 'req_123',
        stopReason: 'end_turn',
        rateLimit: { remaining: 0, resetAt: 1713340860000 },
        quota: { exhausted: false, message: 'ok' },
      },
    });

    expect(events[0]?.event).toEqual({
      kind: 'context',
      used: 80,
      total: 100,
      percentage: 80,
      inputTokens: 60,
      outputTokens: 20,
      source: 'provider-usage',
      promptWeight: 0.75,
      promptWeightBreakdown: {
        systemPrompt: 25,
        mcpToolDescriptions: 15,
        skills: 10,
        userPrompt: 10,
      },
    });
    expect(events[1]?.event).toEqual({
      kind: 'complete',
      tokensUsed: 80,
      durationMs: 900,
      requestId: 'req_123',
      stopReason: 'end_turn',
      rateLimit: { remaining: 0, resetAt: 1713340860000 },
      quota: { exhausted: false, message: 'ok' },
    });
  });

  it('drops overlong provider diagnostic strings that would violate the runtime contract', () => {
    const adapter = new EventEmitter();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    adapter.emit('complete', {
      metadata: {
        requestId: 'r'.repeat(301),
        stopReason: 's'.repeat(301),
      },
    });

    expect(events[0]?.event).toEqual({ kind: 'complete' });
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
