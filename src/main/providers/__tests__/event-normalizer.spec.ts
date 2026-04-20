import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  ClaudeEventMapper,
  CodexEventMapper,
  GeminiEventMapper,
  CopilotEventMapper,
  normalizeAdapterEvent,
  registerEventMapper,
  getEventMapper,
} from '../event-normalizer';
import type { OutputMessage, ContextUsage } from '../../../shared/types/instance.types';

// ============================================
// Helpers
// ============================================

function makeOutputMessage(overrides?: Partial<OutputMessage>): OutputMessage {
  return {
    id: 'msg-1',
    timestamp: 1713340800000,
    type: 'assistant',
    content: 'Hello world',
    metadata: { model: 'opus' },
    ...overrides,
  };
}

function makeContextUsage(overrides?: Partial<ContextUsage>): ContextUsage {
  return {
    used: 5000,
    total: 200000,
    percentage: 2.5,
    ...overrides,
  };
}

// ============================================
// Per-mapper normalize() tests
// ============================================

const mapperCases: Array<{ name: string; factory: () => { provider: string; normalize: (rawEventType: string, ...args: unknown[]) => unknown } }> = [
  { name: 'ClaudeEventMapper', factory: () => new ClaudeEventMapper() },
  { name: 'CodexEventMapper', factory: () => new CodexEventMapper() },
  { name: 'GeminiEventMapper', factory: () => new GeminiEventMapper() },
  { name: 'CopilotEventMapper', factory: () => new CopilotEventMapper() },
];

for (const { name, factory } of mapperCases) {
  describe(name, () => {
    let mapper: ReturnType<typeof factory>;

    beforeEach(() => {
      mapper = factory();
    });

    // --- output ---
    it('normalizes "output" into kind:output with content and metadata', () => {
      const msg = makeOutputMessage();
      const result = mapper.normalize('output', msg);
      expect(result).toEqual({
        kind: 'output',
        content: 'Hello world',
        messageType: 'assistant',
        messageId: 'msg-1',
        timestamp: 1713340800000,
        metadata: { model: 'opus' },
      });
    });

    it('normalizes "output" without metadata', () => {
      const msg = makeOutputMessage({ metadata: undefined });
      const result = mapper.normalize('output', msg);
      expect(result).toEqual({
        kind: 'output',
        content: 'Hello world',
        messageType: 'assistant',
        messageId: 'msg-1',
        timestamp: 1713340800000,
      });
    });

    it('normalizes attachment-only output without dropping thinking payloads', () => {
      const msg = makeOutputMessage({
        content: '',
        attachments: [{ name: 'diagram.png', type: 'image/png', size: 4, data: 'abcd' }],
        thinking: [{ id: 'thinking-1', content: 'Inspect call flow', format: 'structured', tokenCount: 12 }],
        thinkingExtracted: true,
      });
      const result = mapper.normalize('output', msg);
      expect(result).toEqual({
        kind: 'output',
        content: '',
        messageType: 'assistant',
        messageId: 'msg-1',
        timestamp: 1713340800000,
        metadata: { model: 'opus' },
        attachments: [{ name: 'diagram.png', type: 'image/png', size: 4, data: 'abcd' }],
        thinking: [{ id: 'thinking-1', content: 'Inspect call flow', format: 'structured', tokenCount: 12 }],
        thinkingExtracted: true,
      });
    });

    // --- status ---
    it('normalizes "status" into kind:status', () => {
      const result = mapper.normalize('status', 'idle');
      expect(result).toEqual({ kind: 'status', status: 'idle' });
    });

    it('normalizes "status" with empty string', () => {
      const result = mapper.normalize('status', '');
      expect(result).toEqual({ kind: 'status', status: '' });
    });

    // --- context ---
    it('normalizes "context" into kind:context with usage fields', () => {
      const usage = makeContextUsage();
      const result = mapper.normalize('context', usage);
      expect(result).toEqual({
        kind: 'context',
        used: 5000,
        total: 200000,
        percentage: 2.5,
      });
    });

    it('normalizes "context" at 100% usage', () => {
      const usage = makeContextUsage({ used: 200000, total: 200000, percentage: 100 });
      const result = mapper.normalize('context', usage);
      expect(result).toEqual({
        kind: 'context',
        used: 200000,
        total: 200000,
        percentage: 100,
      });
    });

    // --- error ---
    it('normalizes "error" from an Error instance', () => {
      const err = new Error('something broke');
      const result = mapper.normalize('error', err);
      expect(result).toEqual({
        kind: 'error',
        message: 'something broke',
        recoverable: false,
      });
    });

    it('normalizes "error" from a string', () => {
      const result = mapper.normalize('error', 'raw string error');
      expect(result).toEqual({
        kind: 'error',
        message: 'raw string error',
        recoverable: false,
      });
    });

    it('normalizes "error" from a number', () => {
      const result = mapper.normalize('error', 42);
      expect(result).toEqual({
        kind: 'error',
        message: '42',
        recoverable: false,
      });
    });

    // --- exit ---
    it('normalizes "exit" with code and signal', () => {
      const result = mapper.normalize('exit', 1, 'SIGTERM');
      expect(result).toEqual({ kind: 'exit', code: 1, signal: 'SIGTERM' });
    });

    it('normalizes "exit" with null code and null signal (clean exit)', () => {
      const result = mapper.normalize('exit', null, null);
      expect(result).toEqual({ kind: 'exit', code: null, signal: null });
    });

    it('normalizes "exit" with code 0', () => {
      const result = mapper.normalize('exit', 0, null);
      expect(result).toEqual({ kind: 'exit', code: 0, signal: null });
    });

    // --- spawned ---
    it('normalizes "spawned" with a pid', () => {
      const result = mapper.normalize('spawned', 12345);
      expect(result).toEqual({ kind: 'spawned', pid: 12345 });
    });

    // --- complete ---
    it('normalizes "complete" with no meaningful args', () => {
      const result = mapper.normalize('complete');
      expect(result).toEqual({ kind: 'complete' });
    });

    // --- unknown ---
    it('returns null for unknown event types', () => {
      expect(mapper.normalize('unknown_event')).toBeNull();
      expect(mapper.normalize('')).toBeNull();
      expect(mapper.normalize('data')).toBeNull();
      expect(mapper.normalize('heartbeat')).toBeNull();
    });
  });
}

// ============================================
// Provider property tests
// ============================================

describe('mapper provider property', () => {
  it('ClaudeEventMapper has provider "claude"', () => {
    expect(new ClaudeEventMapper().provider).toBe('claude');
  });

  it('CodexEventMapper has provider "codex"', () => {
    expect(new CodexEventMapper().provider).toBe('codex');
  });

  it('GeminiEventMapper has provider "gemini"', () => {
    expect(new GeminiEventMapper().provider).toBe('gemini');
  });

  it('CopilotEventMapper has provider "copilot"', () => {
    expect(new CopilotEventMapper().provider).toBe('copilot');
  });
});

// ============================================
// Mapper Registry
// ============================================

describe('mapper registry', () => {
  it('built-in mappers are registered by module import', () => {
    expect(getEventMapper('claude')).toBeInstanceOf(ClaudeEventMapper);
    expect(getEventMapper('codex')).toBeInstanceOf(CodexEventMapper);
    expect(getEventMapper('gemini')).toBeInstanceOf(GeminiEventMapper);
    expect(getEventMapper('copilot')).toBeInstanceOf(CopilotEventMapper);
  });

  it('returns undefined for an unregistered provider', () => {
    expect(getEventMapper('nonexistent')).toBeUndefined();
  });

  it('registerEventMapper overwrites an existing mapper', () => {
    const custom = new ClaudeEventMapper();
    registerEventMapper(custom);
    expect(getEventMapper('claude')).toBe(custom);
  });
});

// ============================================
// normalizeAdapterEvent
// ============================================

describe('normalizeAdapterEvent', () => {
  it('returns an envelope with correct structure for a known provider', () => {
    const msg = makeOutputMessage();
    const env = normalizeAdapterEvent('claude', 'inst-1', 'output', [msg], 'sess-1');

    expect(env).not.toBeNull();
    expect(env!.provider).toBe('claude');
    expect(env!.instanceId).toBe('inst-1');
    expect(env!.sessionId).toBe('sess-1');
    expect(env!.event.kind).toBe('output');
    // timestamp should be a numeric ms-since-epoch value (Date.now())
    expect(typeof env!.timestamp).toBe('number');
    expect(Number.isFinite(env!.timestamp)).toBe(true);
    expect(() => new Date(env!.timestamp).toISOString()).not.toThrow();
  });

  it('returns envelope without sessionId when omitted', () => {
    const env = normalizeAdapterEvent('codex', 'inst-2', 'status', ['busy']);

    expect(env).not.toBeNull();
    expect(env!.sessionId).toBeUndefined();
    expect(env!.event).toEqual({ kind: 'status', status: 'busy' });
  });

  it('returns null for an unknown provider', () => {
    const env = normalizeAdapterEvent('unknown-provider', 'inst-3', 'output', [makeOutputMessage()]);
    expect(env).toBeNull();
  });

  it('returns null when the mapper does not recognize the event type', () => {
    const env = normalizeAdapterEvent('claude', 'inst-4', 'garbage_event', []);
    expect(env).toBeNull();
  });

  it('works with all built-in providers', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'copilot']) {
      const env = normalizeAdapterEvent(provider, `inst-${provider}`, 'complete', []);
      expect(env).not.toBeNull();
      expect(env!.provider).toBe(provider);
      expect(env!.event).toEqual({ kind: 'complete' });
    }
  });

  it('passes multiple args through for exit event', () => {
    const env = normalizeAdapterEvent('claude', 'inst-5', 'exit', [137, 'SIGKILL'], 'sess-5');

    expect(env).not.toBeNull();
    expect(env!.event).toEqual({ kind: 'exit', code: 137, signal: 'SIGKILL' });
  });

  it('passes error args through for error event', () => {
    const err = new Error('adapter failure');
    const env = normalizeAdapterEvent('gemini', 'inst-6', 'error', [err]);

    expect(env).not.toBeNull();
    expect(env!.event).toEqual({
      kind: 'error',
      message: 'adapter failure',
      recoverable: false,
    });
  });

  it('generates a unique UUID v4 eventId for each envelope', () => {
    const env1 = normalizeAdapterEvent('claude', 'inst-1', 'status', ['busy']);
    const env2 = normalizeAdapterEvent('claude', 'inst-1', 'status', ['busy']);
    expect(env1).not.toBeNull();
    expect(env2).not.toBeNull();
    expect(env1!.eventId).not.toBe(env2!.eventId);
    expect(env1!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('passes the seq parameter through to the envelope', () => {
    const env = normalizeAdapterEvent('claude', 'inst-1', 'status', ['busy'], undefined, 42);
    expect(env).not.toBeNull();
    expect(env!.seq).toBe(42);
  });
});
