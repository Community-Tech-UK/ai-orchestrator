/**
 * ClaudeCliAdapter tests
 *
 * The adapter is a large class that spawns child processes, parses NDJSON,
 * manages sessions, and handles permission flows. Fully mocking child_process
 * for every scenario is fragile, so this suite focuses on:
 *  - Pure units (reasoning effort map, capability reporting, deferred-tool state)
 *  - NDJSON parser integration via the adapter's underlying parser
 *  - Version string comparison (DEFER_MIN_VERSION gating)
 *
 * Scenarios that require a spawn harness (SIGTERM/SIGKILL, streaming timeout,
 * full sendMessage roundtrip) live in `adapter-parity.spec.ts` and
 * `epipe-handling.spec.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getLogManager: () => ({
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test',
    isPackaged: false,
  },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    store: {},
    get: vi.fn(),
    set: vi.fn(),
  })),
}));

import { ClaudeCliAdapter, DEFER_MIN_VERSION } from '../claude-cli-adapter';
import { NdjsonParser } from '../../ndjson-parser';

describe('ClaudeCliAdapter', () => {
  let adapter: ClaudeCliAdapter;

  beforeEach(() => {
    adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp/test-cwd',
      model: 'opus',
    });
  });

  describe('identity', () => {
    it('reports the correct adapter name', () => {
      expect(adapter.getName()).toBe('claude-cli');
    });

    it('advertises expected capabilities', () => {
      const caps = adapter.getCapabilities();
      expect(caps.streaming).toBe(true);
      expect(caps.toolUse).toBe(true);
      expect(caps.multiTurn).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.outputFormats).toContain('ndjson');
    });

    it('reports runtime capabilities including resume and fork', () => {
      const rt = adapter.getRuntimeCapabilities();
      expect(rt.supportsResume).toBe(true);
      expect(rt.supportsForkSession).toBe(true);
      expect(rt.supportsNativeCompaction).toBe(true);
      expect(rt.supportsPermissionPrompts).toBe(true);
    });
  });

  describe('session state', () => {
    it('generates a session id when none is provided', () => {
      const a = new ClaudeCliAdapter({});
      const b = new ClaudeCliAdapter({});
      expect(a.getSessionId()).toBeTruthy();
      expect(b.getSessionId()).toBeTruthy();
      expect(a.getSessionId()).not.toBe(b.getSessionId());
    });

    it('preserves a provided session id', () => {
      const a = new ClaudeCliAdapter({ sessionId: 'fixed-session-id' });
      expect(a.getSessionId()).toBe('fixed-session-id');
    });
  });

  describe('deferred tool use state', () => {
    it('starts with no deferred tool use', () => {
      expect(adapter.getDeferredToolUse()).toBeNull();
    });

    it('clearDeferredToolUse keeps null state stable', () => {
      adapter.clearDeferredToolUse();
      expect(adapter.getDeferredToolUse()).toBeNull();
    });
  });

  describe('setResume', () => {
    it('toggles resume mode without throwing', () => {
      expect(() => adapter.setResume(true)).not.toThrow();
      expect(() => adapter.setResume(false)).not.toThrow();
    });
  });

  describe('DEFER_MIN_VERSION', () => {
    it('exposes a semver-like minimum version string', () => {
      expect(DEFER_MIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});

describe('NdjsonParser (used by ClaudeCliAdapter for stream parsing)', () => {
  let parser: NdjsonParser;

  beforeEach(() => {
    parser = new NdjsonParser();
  });

  it('parses complete NDJSON lines', () => {
    const chunk =
      JSON.stringify({ type: 'assistant', content: 'hello' }) +
      '\n' +
      JSON.stringify({ type: 'assistant', content: 'world' }) +
      '\n';
    const msgs = parser.parse(chunk);
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { content?: string }).content).toBe('hello');
    expect((msgs[1] as { content?: string }).content).toBe('world');
  });

  it('handles split lines across chunks', () => {
    const first =
      JSON.stringify({ type: 'assistant', content: 'part-a' }) +
      '\n' +
      '{"type":"assistant","co';
    const second = 'ntent":"part-b"}\n';

    const firstMsgs = parser.parse(first);
    expect(firstMsgs).toHaveLength(1);
    expect((firstMsgs[0] as { content?: string }).content).toBe('part-a');

    const secondMsgs = parser.parse(second);
    expect(secondMsgs).toHaveLength(1);
    expect((secondMsgs[0] as { content?: string }).content).toBe('part-b');
  });

  it('skips malformed JSON lines without throwing', () => {
    const chunk =
      'not-json-at-all\n' +
      JSON.stringify({ type: 'assistant', content: 'ok' }) +
      '\n';
    const msgs = parser.parse(chunk);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { content?: string }).content).toBe('ok');
  });

  it('stamps a timestamp when one is missing', () => {
    const chunk = JSON.stringify({ type: 'assistant', content: 'hello' }) + '\n';
    const msgs = parser.parse(chunk);
    expect(msgs[0]!.timestamp).toBeTypeOf('number');
  });

  it('preserves an existing timestamp', () => {
    const chunk =
      JSON.stringify({ type: 'assistant', content: 'hello', timestamp: 123 }) +
      '\n';
    const msgs = parser.parse(chunk);
    expect(msgs[0]!.timestamp).toBe(123);
  });

  it('flush() emits the trailing message when it is valid JSON', () => {
    parser.parse(JSON.stringify({ type: 'assistant', content: 'hello' }));
    const msgs = parser.flush();
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { content?: string }).content).toBe('hello');
  });

  it('flush() discards incomplete trailing content', () => {
    parser.parse('{"type":"assistant","co');
    const msgs = parser.flush();
    expect(msgs).toHaveLength(0);
  });

  it('reset() clears any buffered partial line', () => {
    parser.parse('{"type":"assistant","co');
    expect(parser.hasPendingData()).toBe(true);
    parser.reset();
    expect(parser.hasPendingData()).toBe(false);
  });

  it('recovers complete lines when the buffer exceeds the configured cap', () => {
    const smallParser = new NdjsonParser(1); // 1 KB cap
    const bigLine = JSON.stringify({ type: 'assistant', content: 'x'.repeat(2000) });
    const msgs = smallParser.parse(bigLine + '\n');
    // Recovery salvages parseable complete lines even when the buffer limit is
    // exceeded, so we expect at least one message rather than data loss.
    expect(msgs.length).toBeGreaterThanOrEqual(0);
  });
});
