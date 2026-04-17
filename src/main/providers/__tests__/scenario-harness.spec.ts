/**
 * WS5: Deterministic Parity & Recovery Harness
 *
 * Scenario tests that verify event ordering, state transitions, and
 * recovery behavior using deterministic fixtures instead of live CLIs.
 *
 * Required scenarios from the improvement plan:
 * 1. Streaming text roundtrip
 * 2. Permission request approved
 * 3. Permission request denied
 * 4. Native resume success
 * 5. Native resume failure + replay fallback
 * 6. Interrupt and respawn
 * 7. MCP tool lifecycle / tool result roundtrip
 * 8. Plugin hook roundtrip and payload validation
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ClaudeEventMapper,
  CodexEventMapper,
  normalizeAdapterEvent,
} from '../event-normalizer';
import type { ProviderRuntimeEvent, ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

// ============================================
// Deterministic Fixtures
// ============================================

function createOutputMessage(content: string, type = 'assistant') {
  return {
    id: `msg-${Date.now()}`,
    timestamp: Date.now(),
    type,
    content,
    metadata: {},
  };
}

function createContextUsage(used: number, total: number) {
  return {
    used,
    total,
    percentage: Math.round((used / total) * 100),
  };
}

// ============================================
// Scenario 1: Streaming text roundtrip
// ============================================

describe('Scenario 1: Streaming text roundtrip', () => {
  it('should normalize sequential output events into provider-agnostic stream', () => {
    const mapper = new ClaudeEventMapper();
    const chunks = [
      'Hello, ',
      'I can help ',
      'you with that.',
    ];

    const events: ProviderRuntimeEvent[] = [];
    for (const chunk of chunks) {
      const msg = createOutputMessage(chunk);
      const event = mapper.normalize('output', msg);
      expect(event).not.toBeNull();
      events.push(event!);
    }

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.kind).toBe('output');
      if (event.kind === 'output') {
        expect(event.messageType).toBe('assistant');
      }
    }
  });

  it('should wrap events in envelope with metadata', () => {
    const msg = createOutputMessage('test content');
    const envelope = normalizeAdapterEvent(
      'claude',
      'inst-123',
      'output',
      [msg],
      'session-456',
    );

    expect(envelope).not.toBeNull();
    expect(envelope!.provider).toBe('claude');
    expect(envelope!.instanceId).toBe('inst-123');
    expect(envelope!.sessionId).toBe('session-456');
    expect(envelope!.event.kind).toBe('output');
    expect(envelope!.timestamp).toBeTruthy();
  });
});

// ============================================
// Scenario 2: Permission request approved
// ============================================

describe('Scenario 2: Permission request approved', () => {
  it('should produce status transitions: busy → waiting → busy → idle', () => {
    const mapper = new ClaudeEventMapper();
    const statuses = ['busy', 'waiting_for_input', 'busy', 'idle'];

    const events = statuses.map((s) => mapper.normalize('status', s));
    expect(events.every((e) => e !== null)).toBe(true);

    const statusValues = events.map((e) => {
      expect(e!.kind).toBe('status');
      return (e as { kind: 'status'; status: string }).status;
    });
    expect(statusValues).toEqual(statuses);
  });
});

// ============================================
// Scenario 3: Permission request denied
// ============================================

describe('Scenario 3: Permission request denied', () => {
  it('should produce error event after denial', () => {
    const mapper = new ClaudeEventMapper();

    const statusBusy = mapper.normalize('status', 'busy');
    const statusWaiting = mapper.normalize('status', 'waiting_for_input');
    const errorEvent = mapper.normalize('error', new Error('Permission denied'));
    const statusIdle = mapper.normalize('status', 'idle');

    expect(statusBusy).not.toBeNull();
    expect(statusWaiting).not.toBeNull();
    expect(errorEvent).not.toBeNull();
    expect(statusIdle).not.toBeNull();

    if (errorEvent!.kind === 'error') {
      expect(errorEvent!.message).toBe('Permission denied');
    }
  });
});

// ============================================
// Scenario 4: Native resume success
// ============================================

describe('Scenario 4: Native resume success', () => {
  it('should produce spawned → status(idle) sequence', () => {
    const mapper = new ClaudeEventMapper();

    const spawned = mapper.normalize('spawned', 12345);
    const idle = mapper.normalize('status', 'idle');

    expect(spawned).not.toBeNull();
    expect(spawned!.kind).toBe('spawned');
    if (spawned!.kind === 'spawned') {
      expect(spawned!.pid).toBe(12345);
    }

    expect(idle).not.toBeNull();
    expect(idle!.kind).toBe('status');
  });
});

// ============================================
// Scenario 5: Resume failure + replay fallback
// ============================================

describe('Scenario 5: Resume failure followed by replay fallback', () => {
  it('should produce error → exit → spawned → status(busy) → output', () => {
    const mapper = new ClaudeEventMapper();

    const events: ProviderRuntimeEvent[] = [
      mapper.normalize('error', new Error('no conversation found'))!,
      mapper.normalize('exit', 1, null)!,
      mapper.normalize('spawned', 67890)!,
      mapper.normalize('status', 'busy')!,
      mapper.normalize('output', createOutputMessage('Resuming with fallback context'))!,
    ];

    expect(events).toHaveLength(5);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['error', 'exit', 'spawned', 'status', 'output']);
  });
});

// ============================================
// Scenario 6: Interrupt and respawn
// ============================================

describe('Scenario 6: Interrupt and respawn behavior', () => {
  it('should handle exit(null, SIGINT) → spawned → idle', () => {
    const mapper = new ClaudeEventMapper();

    const exit = mapper.normalize('exit', null, 'SIGINT');
    expect(exit).not.toBeNull();
    if (exit!.kind === 'exit') {
      expect(exit!.code).toBeNull();
      expect(exit!.signal).toBe('SIGINT');
    }

    const spawned = mapper.normalize('spawned', 11111);
    const idle = mapper.normalize('status', 'idle');
    expect(spawned!.kind).toBe('spawned');
    expect(idle!.kind).toBe('status');
  });
});

// ============================================
// Scenario 7: MCP tool lifecycle
// ============================================

describe('Scenario 7: MCP tool lifecycle / tool result roundtrip', () => {
  it('should normalize tool-related output events', () => {
    const mapper = new ClaudeEventMapper();

    const toolUseMsg = createOutputMessage('Using tool: Read', 'tool_use');
    const toolResultMsg = createOutputMessage('File contents: ...', 'tool_result');

    const toolUse = mapper.normalize('output', toolUseMsg);
    const toolResult = mapper.normalize('output', toolResultMsg);

    expect(toolUse).not.toBeNull();
    expect(toolResult).not.toBeNull();

    if (toolUse!.kind === 'output') {
      expect(toolUse!.messageType).toBe('tool_use');
    }
    if (toolResult!.kind === 'output') {
      expect(toolResult!.messageType).toBe('tool_result');
    }
  });
});

// ============================================
// Scenario 8: Plugin hook roundtrip
// ============================================

describe('Scenario 8: Plugin hook roundtrip and payload validation', () => {
  it('should validate hook payloads using contract schemas', async () => {
    const { validateHookPayload } = await import('@contracts/schemas');

    // Valid payload
    const result = validateHookPayload('instance.created', {
      instanceId: 'inst-001',
      id: 'inst-001',
      workingDirectory: '/home/user/project',
      provider: 'claude',
    });
    expect(result).toBeDefined();
  });

  it('should reject invalid hook payloads with actionable errors', async () => {
    const { validateHookPayload } = await import('@contracts/schemas');

    expect(() => {
      validateHookPayload('instance.created', {
        // Missing required 'id' and 'workingDirectory'
        instanceId: 'inst-001',
      });
    }).toThrow();
  });
});

// ============================================
// Cross-provider parity
// ============================================

describe('Cross-provider event parity', () => {
  it('should normalize the same event identically across Claude and Codex', () => {
    const claudeMapper = new ClaudeEventMapper();
    const codexMapper = new CodexEventMapper();
    const msg = createOutputMessage('Hello world');

    const claudeEvent = claudeMapper.normalize('output', msg);
    const codexEvent = codexMapper.normalize('output', msg);

    expect(claudeEvent).toEqual(codexEvent);
  });

  it('should normalize context events with consistent shape', () => {
    const claudeMapper = new ClaudeEventMapper();
    const codexMapper = new CodexEventMapper();
    const usage = createContextUsage(5000, 200000);

    const claudeContext = claudeMapper.normalize('context', usage);
    const codexContext = codexMapper.normalize('context', usage);

    expect(claudeContext).toEqual(codexContext);
    if (claudeContext!.kind === 'context') {
      expect(claudeContext!.used).toBe(5000);
      expect(claudeContext!.total).toBe(200000);
    }
  });

  it('should return null for unknown event types across all mappers', () => {
    const claudeMapper = new ClaudeEventMapper();
    const codexMapper = new CodexEventMapper();

    expect(claudeMapper.normalize('unknown_event')).toBeNull();
    expect(codexMapper.normalize('unknown_event')).toBeNull();
  });
});
