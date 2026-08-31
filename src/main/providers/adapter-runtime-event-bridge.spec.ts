import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import {
  mapAdapterRuntimeEvent,
  observeAdapterRuntimeEvents,
  toProviderToolResultObservedEvent,
  toProviderToolUseObservedEvent,
  UNKNOWN_EVENT_PAYLOAD_MAX_BYTES,
  type NormalizedAdapterRuntimeEvent,
} from './adapter-runtime-event-bridge';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';

describe('observeAdapterRuntimeEvents', () => {
  it('maps adapter events purely while retaining the original context payload', () => {
    const raw = {
      used: 10,
      total: 100,
      prompt_tokens: 7,
      completion_tokens: 3,
      providerDiagnostic: 'native-only',
    };

    expect(mapAdapterRuntimeEvent('context', [raw])).toEqual({
      event: {
        kind: 'context',
        used: 10,
        total: 100,
        percentage: 10,
        inputTokens: 7,
        outputTokens: 3,
      },
      rawPayload: raw,
    });
  });

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

  it('normalizes the actual Claude tool and complete payload shapes losslessly', () => {
    expect(mapAdapterRuntimeEvent('tool_use', [{
      id: 'call-placeholder',
      name: 'Read',
      input: { path: '/fixture' },
    }])?.event).toEqual({
      kind: 'tool_use',
      toolName: 'Read',
      toolUseId: 'call-placeholder',
      input: { path: '/fixture' },
    });
    expect(mapAdapterRuntimeEvent('tool_result', [{
      tool_use_id: 'call-placeholder',
      name: 'Read',
      content: 'fixture result',
      is_error: true,
    }])?.event).toEqual({
      kind: 'tool_result',
      toolName: 'Read',
      toolUseId: 'call-placeholder',
      success: false,
      output: 'fixture result',
      error: 'fixture result',
    });
    expect(mapAdapterRuntimeEvent('complete', [{
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        totalTokens: 28,
      },
    }])?.event).toMatchObject({
      kind: 'complete',
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      tokensUsed: 28,
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

  it('surfaces input/output tokens from alternate provider field conventions (prompt_tokens/completion_tokens)', () => {
    const adapter = new EventEmitter();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    // OpenAI-style snake_case usage fields that the previous two-variant reader
    // ignored — these must now flow through to the context ring.
    adapter.emit('context', {
      used: 50,
      total: 200,
      percentage: 25,
      prompt_tokens: 40,
      completion_tokens: 10,
    });

    const ctx = events[0]?.event as { kind: string; inputTokens?: number; outputTokens?: number };
    expect(ctx.kind).toBe('context');
    expect(ctx.inputTokens).toBe(40);
    expect(ctx.outputTokens).toBe(10);
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

  it('propagates the A3 degradedReason tag from the CliResponse onto the complete event', () => {
    const adapter = new EventEmitter();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    adapter.emit('complete', {
      id: 'x',
      content: '',
      role: 'assistant',
      degradedReason: 'delayed',
    });

    expect(events[0]?.event).toEqual({ kind: 'complete', degradedReason: 'delayed' });
  });

  it('omits degradedReason on healthy (untagged) completions', () => {
    const adapter = new EventEmitter();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    adapter.emit('complete', { id: 'x', content: 'ok', role: 'assistant' });

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

describe('WS-B10 unknown-event routing', () => {
  it('routes a malformed output payload to `unknown` instead of dropping it', () => {
    // Object shape with non-string content — normalizeOutputMessage rejects this.
    const malformed = { id: 'msg-1', timestamp: 1, type: 'assistant', content: 42 };

    const mapped = mapAdapterRuntimeEvent('output', [malformed]);

    expect(mapped?.event).toMatchObject({
      kind: 'unknown',
      rawType: 'output',
      payload: malformed,
    });
    expect(typeof (mapped?.event as { receivedAt: number }).receivedAt).toBe('number');
  });

  it('still silently drops empty-string output (intentional no-op, not unrecognized)', () => {
    expect(mapAdapterRuntimeEvent('output', [''])).toBeNull();
  });

  it('routes a malformed context payload to `unknown` instead of dropping it', () => {
    const malformed = { notUsed: true };

    const mapped = mapAdapterRuntimeEvent('context', [malformed]);

    expect(mapped?.event).toMatchObject({
      kind: 'unknown',
      rawType: 'context',
      payload: malformed,
    });
  });

  it('caps an oversized unknown-event payload with a truncated marker', () => {
    const huge = { blob: 'x'.repeat(UNKNOWN_EVENT_PAYLOAD_MAX_BYTES * 2) };

    const mapped = mapAdapterRuntimeEvent('context', [huge]);
    const event = mapped?.event as { kind: string; payload: unknown };

    expect(event.kind).toBe('unknown');
    expect(event.payload).toMatchObject({
      truncated: true,
      maxBytes: UNKNOWN_EVENT_PAYLOAD_MAX_BYTES,
    });
    expect(JSON.stringify(event.payload).length).toBeLessThan(JSON.stringify(huge).length);
  });
});

describe('WS-B10 tool observation normalization', () => {
  const toolCall: CliToolCall = {
    id: 'tool-1',
    name: 'Read',
    arguments: { path: 'README.md' },
    result: 'file contents here',
  };

  it('normalizes a tool_use CliToolCall into tool_use_observed with a stable hash and bounded summary', () => {
    const event = toProviderToolUseObservedEvent(toolCall);

    expect(event).toEqual({
      kind: 'tool_use_observed',
      toolName: 'Read',
      callId: 'tool-1',
      argsHash: expect.any(String),
      argsSummary: JSON.stringify({ path: 'README.md' }),
    });
    // Same arguments (even with different key order) hash identically.
    const reordered = toProviderToolUseObservedEvent({
      ...toolCall,
      arguments: { path: 'README.md' },
    });
    expect(reordered.argsHash).toBe(event.argsHash);
  });

  it('normalizes a tool_result CliToolCall into tool_result_observed', () => {
    const event = toProviderToolResultObservedEvent(toolCall);

    expect(event).toEqual({
      kind: 'tool_result_observed',
      callId: 'tool-1',
      resultHash: expect.any(String),
      resultSummary: 'file contents here',
    });
  });

  it('omits result fields when the raw tool call has no result yet', () => {
    const event = toProviderToolResultObservedEvent({ id: 'tool-2', name: 'Bash', arguments: {} });

    expect(event).toEqual({
      kind: 'tool_result_observed',
      callId: 'tool-2',
      resultSummary: '',
    });
  });

  it('truncates an overlong summary', () => {
    const longResult = 'y'.repeat(500);
    const event = toProviderToolResultObservedEvent({ id: 'tool-3', name: 'Bash', arguments: {}, result: longResult });

    expect(event.resultSummary.length).toBeLessThan(longResult.length);
    expect(event.resultSummary.endsWith('…')).toBe(true);
  });
});

describe('LT-061: argsHash ignores cosmetic annotation fields', () => {
  it('hashes identically when only the Bash tool description text varies across calls', () => {
    const first = toProviderToolUseObservedEvent({
      id: 't1',
      name: 'Bash',
      arguments: { command: 'cat /tmp/watch.txt', description: 'Read watch.txt (1/8)' },
    });
    const second = toProviderToolUseObservedEvent({
      id: 't2',
      name: 'Bash',
      arguments: { command: 'cat /tmp/watch.txt', description: 'Read watch.txt (2/8)' },
    });

    expect(second.argsHash).toBe(first.argsHash);
  });

  it('still hashes differently when the operative command genuinely changes', () => {
    const first = toProviderToolUseObservedEvent({
      id: 't1',
      name: 'Bash',
      arguments: { command: 'cat /tmp/watch.txt', description: 'Read watch.txt (1/8)' },
    });
    const second = toProviderToolUseObservedEvent({
      id: 't2',
      name: 'Bash',
      arguments: { command: 'cat /tmp/other.txt', description: 'Read watch.txt (1/8)' },
    });

    expect(second.argsHash).not.toBe(first.argsHash);
  });

  it('generalizes beyond the Bash tool and beyond the description field name', () => {
    // A hypothetical future provider/tool with a differently-named annotation
    // field (`reason`) on a tool that is not `Bash`. Proves the exclusion is
    // not gated on tool identity.
    const first = toProviderToolUseObservedEvent({
      id: 't1',
      name: 'mcp__example__poll_status',
      arguments: { target: 'job-42', reason: 'checking (1/3)' },
    });
    const second = toProviderToolUseObservedEvent({
      id: 't2',
      name: 'mcp__example__poll_status',
      arguments: { target: 'job-42', reason: 'checking (2/3)' },
    });

    expect(second.argsHash).toBe(first.argsHash);
  });

  it('still distinguishes genuinely different operative arguments on that same hypothetical tool', () => {
    const first = toProviderToolUseObservedEvent({
      id: 't1',
      name: 'mcp__example__poll_status',
      arguments: { target: 'job-42', reason: 'checking (1/3)' },
    });
    const second = toProviderToolUseObservedEvent({
      id: 't2',
      name: 'mcp__example__poll_status',
      arguments: { target: 'job-43', reason: 'checking (1/3)' },
    });

    expect(second.argsHash).not.toBe(first.argsHash);
  });

  it('leaves argsSummary untouched (annotation fields still shown to humans)', () => {
    const event = toProviderToolUseObservedEvent({
      id: 't1',
      name: 'Bash',
      arguments: { command: 'cat /tmp/watch.txt', description: 'Read watch.txt (1/8)' },
    });

    expect(event.argsSummary).toContain('description');
    expect(event.argsSummary).toContain('Read watch.txt (1/8)');
  });
});
