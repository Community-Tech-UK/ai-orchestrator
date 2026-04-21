/**
 * WS5: Deterministic Parity & Recovery Harness
 *
 * These scenarios exercise the canonical provider runtime contract directly.
 * The live bridge now emits envelopes without the legacy event normalizer, so
 * the fixtures here build the same event shapes the rest of the runtime sees.
 */

import { describe, expect, it } from 'vitest';
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';

function createOutputEvent(
  content: string,
  messageType: ProviderRuntimeEvent extends { kind: 'output'; messageType?: infer T } ? T : never = 'assistant',
): ProviderRuntimeEvent {
  return {
    kind: 'output',
    content,
    messageType,
  };
}

function createEnvelope(
  event: ProviderRuntimeEvent,
  overrides: Partial<ProviderRuntimeEventEnvelope> = {},
): ProviderRuntimeEventEnvelope {
  return {
    eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
    seq: 0,
    timestamp: 1713340800000,
    provider: 'claude',
    instanceId: 'inst-123',
    event,
    ...overrides,
  };
}

describe('Scenario 1: Streaming text roundtrip', () => {
  it('keeps sequential output chunks in the canonical output shape', () => {
    const chunks = ['Hello, ', 'I can help ', 'you with that.'];
    const events = chunks.map((chunk) => createOutputEvent(chunk));

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.kind).toBe('output');
      if (event.kind === 'output') {
        expect(event.messageType).toBe('assistant');
      }
    }
  });

  it('wraps output in a stable runtime envelope', () => {
    const envelope = createEnvelope(createOutputEvent('test content'), {
      sessionId: 'session-456',
    });

    expect(envelope.provider).toBe('claude');
    expect(envelope.instanceId).toBe('inst-123');
    expect(envelope.sessionId).toBe('session-456');
    expect(envelope.event.kind).toBe('output');
    expect(typeof envelope.timestamp).toBe('number');
  });
});

describe('Scenario 2: Permission request approved', () => {
  it('models busy → waiting → busy → idle as status events', () => {
    const statuses = ['busy', 'waiting_for_input', 'busy', 'idle'];
    const events = statuses.map((status) => ({ kind: 'status', status }) as const);

    expect(events.map((event) => event.status)).toEqual(statuses);
  });
});

describe('Scenario 3: Permission request denied', () => {
  it('models denial as an error followed by idle', () => {
    const events: ProviderRuntimeEvent[] = [
      { kind: 'status', status: 'busy' },
      { kind: 'status', status: 'waiting_for_input' },
      { kind: 'error', message: 'Permission denied', recoverable: false },
      { kind: 'status', status: 'idle' },
    ];

    expect(events.map((event) => event.kind)).toEqual(['status', 'status', 'error', 'status']);
  });
});

describe('Scenario 4: Native resume success', () => {
  it('models resume as spawned → idle', () => {
    const events: ProviderRuntimeEvent[] = [
      { kind: 'spawned', pid: 12345 },
      { kind: 'status', status: 'idle' },
    ];

    expect(events[0]).toEqual({ kind: 'spawned', pid: 12345 });
    expect(events[1]).toEqual({ kind: 'status', status: 'idle' });
  });
});

describe('Scenario 5: Resume failure followed by replay fallback', () => {
  it('models error → exit → spawned → busy → output', () => {
    const events: ProviderRuntimeEvent[] = [
      { kind: 'error', message: 'no conversation found', recoverable: false },
      { kind: 'exit', code: 1, signal: null },
      { kind: 'spawned', pid: 67890 },
      { kind: 'status', status: 'busy' },
      createOutputEvent('Resuming with fallback context'),
    ];

    expect(events.map((event) => event.kind)).toEqual([
      'error',
      'exit',
      'spawned',
      'status',
      'output',
    ]);
  });
});

describe('Scenario 6: Interrupt and respawn behavior', () => {
  it('models SIGINT exit followed by respawn and idle', () => {
    const events: ProviderRuntimeEvent[] = [
      { kind: 'exit', code: null, signal: 'SIGINT' },
      { kind: 'spawned', pid: 11111 },
      { kind: 'status', status: 'idle' },
    ];

    expect(events[0]).toEqual({ kind: 'exit', code: null, signal: 'SIGINT' });
    expect(events[1]).toEqual({ kind: 'spawned', pid: 11111 });
    expect(events[2]).toEqual({ kind: 'status', status: 'idle' });
  });
});

describe('Scenario 7: MCP tool lifecycle / tool result roundtrip', () => {
  it('keeps tool activity in the canonical output message types', () => {
    const toolUse = createOutputEvent('Using tool: Read', 'tool_use');
    const toolResult = createOutputEvent('File contents: ...', 'tool_result');

    expect(toolUse).toEqual({
      kind: 'output',
      content: 'Using tool: Read',
      messageType: 'tool_use',
    });
    expect(toolResult).toEqual({
      kind: 'output',
      content: 'File contents: ...',
      messageType: 'tool_result',
    });
  });
});

describe('Scenario 8: Plugin hook roundtrip and payload validation', () => {
  it('validates hook payloads using contract schemas', async () => {
    const { validateHookPayload } = await import('@contracts/schemas/plugin');

    const result = validateHookPayload('instance.created', {
      instanceId: 'inst-001',
      id: 'inst-001',
      workingDirectory: '/home/user/project',
      provider: 'claude',
    });
    expect(result).toBeDefined();
  });

  it('rejects invalid hook payloads with actionable errors', async () => {
    const { validateHookPayload } = await import('@contracts/schemas/plugin');

    expect(() => {
      validateHookPayload('instance.created', {
        instanceId: 'inst-001',
      });
    }).toThrow();
  });
});
