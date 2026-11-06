import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import {
  CLAUDE_CACHE_LIFETIME_1H_MS,
  CLAUDE_CACHE_LIFETIME_5M_MS,
  ClaudeCacheLifetimeTracker,
  cacheLifetimeFromUsage,
  getClaudeCacheLifetime,
  observeClaudeCacheLifetime,
  recordClaudeCacheLifetime,
} from './claude-cache-lifetime';

const writes = (five: number, hour: number) => ({ cache_creation_input_tokens: five + hour, cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour } });
const frame = (usage: unknown, parent?: string) => ({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { usage } });

describe('cache lifetime implied by one reply', () => {
  it.each([
    [writes(0, 4_000), CLAUDE_CACHE_LIFETIME_1H_MS],
    [writes(900, 0), CLAUDE_CACHE_LIFETIME_5M_MS],
    [writes(100, 4_000), CLAUDE_CACHE_LIFETIME_1H_MS],
    [writes(4_000, 100), CLAUDE_CACHE_LIFETIME_5M_MS],
    [writes(500, 500), CLAUDE_CACHE_LIFETIME_5M_MS],
  ])('maps %j to %i ms (the larger share of what was written decides; a tie takes the shorter)', (usage, expected) => {
    expect(cacheLifetimeFromUsage(usage)).toBe(expected);
  });

  it.each([undefined, null, {}, { cache_read_input_tokens: 9_000 }, writes(0, 0), { cache_creation: { ephemeral_1h_input_tokens: -5 } }, 'text'])(
    'has no opinion when the reply wrote nothing to the cache (%j)', (usage) => {
      expect(cacheLifetimeFromUsage(usage)).toBeUndefined();
    });
});

describe('ClaudeCacheLifetimeTracker', () => {
  it('knows nothing before a reply has written to the cache', () => {
    const tracker = new ClaudeCacheLifetimeTracker();
    expect(tracker.get()).toBeNull();
    expect(tracker.observeAssistant(frame({ cache_read_input_tokens: 5 }), 10)).toBeNull();
    expect(tracker.get()).toBeNull();
  });

  it('follows the latest write, carries it over read-only replies, and ignores helper frames', () => {
    const tracker = new ClaudeCacheLifetimeTracker();
    expect(tracker.observeAssistant(frame(writes(0, 3_000)), 1_000)).toEqual({ lifetimeMs: CLAUDE_CACHE_LIFETIME_1H_MS, observedAt: 1_000, changed: true });
    expect(tracker.observeAssistant(frame(writes(900, 0), 'toolu_helper'), 2_000)).toBeNull();
    expect(tracker.observeAssistant(frame({ cache_read_input_tokens: 9_000 }), 3_000)).toEqual({ lifetimeMs: CLAUDE_CACHE_LIFETIME_1H_MS, observedAt: 3_000, changed: false });
    expect(tracker.observeAssistant(frame(writes(800, 0)), 4_000)).toEqual({ lifetimeMs: CLAUDE_CACHE_LIFETIME_5M_MS, observedAt: 4_000, changed: true });
    expect(tracker.get()).toEqual({ lifetimeMs: CLAUDE_CACHE_LIFETIME_5M_MS, observedAt: 4_000 });
  });
});

describe('host helpers', () => {
  it('emits cache_lifetime only when the lifetime changes and keeps the latest value readable', () => {
    const host = new EventEmitter();
    const seen = vi.fn();
    host.on('cache_lifetime', seen);
    observeClaudeCacheLifetime(host, frame(writes(0, 100)), 1);
    observeClaudeCacheLifetime(host, frame(writes(0, 100)), 2);
    observeClaudeCacheLifetime(host, frame(writes(70, 0)), 3);
    expect(seen.mock.calls.map((call) => call[0])).toEqual([
      { lifetimeMs: CLAUDE_CACHE_LIFETIME_1H_MS, observedAt: 1 },
      { lifetimeMs: CLAUDE_CACHE_LIFETIME_5M_MS, observedAt: 3 },
    ]);
    expect(getClaudeCacheLifetime(host)).toEqual({ lifetimeMs: CLAUDE_CACHE_LIFETIME_5M_MS, observedAt: 3 });
  });

  it('accepts a value relayed from another process, and refuses nonsense', () => {
    const host = new EventEmitter();
    recordClaudeCacheLifetime(host, { lifetimeMs: CLAUDE_CACHE_LIFETIME_1H_MS, observedAt: 50 });
    expect(getClaudeCacheLifetime(host)).toEqual({ lifetimeMs: CLAUDE_CACHE_LIFETIME_1H_MS, observedAt: 50 });
    recordClaudeCacheLifetime(host, { lifetimeMs: -1, observedAt: 60 });
    recordClaudeCacheLifetime(host, { lifetimeMs: Number.NaN, observedAt: 60 });
    expect(getClaudeCacheLifetime(host)).toEqual({ lifetimeMs: CLAUDE_CACHE_LIFETIME_1H_MS, observedAt: 50 });
    expect(getClaudeCacheLifetime({})).toBeNull();
    expect(getClaudeCacheLifetime(undefined)).toBeNull();
  });

  it('is fed by the real adapter stream path', () => {
    const adapter = new ClaudeCliAdapter({ workingDirectory: '/tmp', model: 'opus' });
    const ingress = adapter as unknown as { processCliMessage(message: unknown): void };
    ingress.processCliMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2, ...writes(0, 8_000) } } });
    expect(getClaudeCacheLifetime(adapter)?.lifetimeMs).toBe(CLAUDE_CACHE_LIFETIME_1H_MS);
    ingress.processCliMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2, ...writes(600, 0) } } });
    expect(getClaudeCacheLifetime(adapter)?.lifetimeMs).toBe(CLAUDE_CACHE_LIFETIME_5M_MS);
  });
});
