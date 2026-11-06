/**
 * Tests for the per-provider concurrency limiter.
 *
 * The limiter exists to prevent the ACP fan-out amplifier: when N
 * Copilot children spawn in parallel and one hangs on an orphaned
 * tool call, the whole batch stalls. Capping concurrent Copilot
 * spawns bounds the blast radius.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ProviderConcurrencyLimiter, applyProviderConcurrencyLimits, DEFAULT_PROVIDER_LIMITS } from './provider-concurrency-limiter';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import { FailoverError, coerceToFailoverError } from '../core/failover-error';
import { classifyLoopError } from '../core/loop-error-classification';

describe('ProviderConcurrencyLimiter', () => {
  beforeEach(() => {
    ProviderConcurrencyLimiter._resetForTesting();
  });

  afterEach(() => {
    ProviderConcurrencyLimiter._resetForTesting();
  });

  it('returns a singleton', () => {
    const a = ProviderConcurrencyLimiter.getInstance();
    const b = ProviderConcurrencyLimiter.getInstance();
    expect(a).toBe(b);
  });

  it('caps OpenCode at 20 concurrent children by default', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    expect(limiter.getStats('opencode')).toEqual({ active: 0, waiting: 0, limit: 20 });
  });

  it('falls back to 6 for a provider without an explicit default cap', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    expect(limiter.getStats('antigravity')).toEqual({ active: 0, waiting: 0, limit: 6 });
  });

  it('applies setting overrides over the built-in defaults', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    applyProviderConcurrencyLimits(limiter, { opencode: 30 });
    expect(limiter.getStats('opencode')).toMatchObject({ limit: 30 });
    expect(limiter.getStats('copilot')).toMatchObject({ limit: 10 });
  });

  it('returns providers to built-in defaults when the setting drops them', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    applyProviderConcurrencyLimits(limiter, { opencode: 30 });
    applyProviderConcurrencyLimits(limiter, {});
    expect(limiter.getStats('opencode')).toMatchObject({ limit: 20 });
  });

  it('returns custom keys with no built-in default to the fallback when dropped', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    applyProviderConcurrencyLimits(limiter, { antigravity: 10 });
    expect(limiter.getStats('antigravity')).toMatchObject({ limit: 10 });
    applyProviderConcurrencyLimits(limiter, {});
    expect(limiter.getStats('antigravity')).toMatchObject({ limit: 6 });
  });

  it('treats an array-shaped override value as no overrides at all', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    applyProviderConcurrencyLimits(limiter, { opencode: 30 });
    applyProviderConcurrencyLimits(limiter, [5] as unknown as Record<string, number>);
    expect(limiter.getStats('opencode')).toMatchObject({ limit: 20 });
    expect(limiter.getStats('0')).toMatchObject({ limit: 6 });
  });

  it('ignores out-of-range or non-integer override values', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    applyProviderConcurrencyLimits(limiter, {
      opencode: 0,
      copilot: 10.5,
      cursor: 101,
      grok: Number.NaN,
    });
    expect(limiter.getStats('opencode')).toMatchObject({ limit: 20 });
    expect(limiter.getStats('copilot')).toMatchObject({ limit: 10 });
    expect(limiter.getStats('cursor')).toMatchObject({ limit: 8 });
    expect(limiter.getStats('grok')).toMatchObject({ limit: 6 });
  });

  it('keeps the settings defaults consistent with the built-in caps', () => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS.concurrencyLimitByProvider)) {
      expect(DEFAULT_PROVIDER_LIMITS[key]).toBe(value);
    }
  });

  it('grants immediate slots up to the limit', async () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit('copilot', 3);

    const r1 = await limiter.acquire('copilot');
    const r2 = await limiter.acquire('copilot');
    const r3 = await limiter.acquire('copilot');

    expect(limiter.getStats('copilot')).toEqual({ active: 3, waiting: 0, limit: 3 });

    r1();
    r2();
    r3();

    expect(limiter.getStats('copilot').active).toBe(0);
  });

  it('queues waiters when the limit is saturated, in FIFO order', async () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit('copilot', 2);

    const r1 = await limiter.acquire('copilot');
    const r2 = await limiter.acquire('copilot');

    const order: number[] = [];
    const p3 = limiter.acquire('copilot').then((release) => {
      order.push(3);
      return release;
    });
    const p4 = limiter.acquire('copilot').then((release) => {
      order.push(4);
      return release;
    });

    // Neither has resolved yet.
    expect(limiter.getStats('copilot')).toMatchObject({ active: 2, waiting: 2 });

    r1();
    const r3 = await p3;
    expect(order).toEqual([3]);
    expect(limiter.getStats('copilot')).toMatchObject({ active: 2, waiting: 1 });

    r2();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);
    expect(limiter.getStats('copilot')).toMatchObject({ active: 2, waiting: 0 });

    r3();
    r4();
    expect(limiter.getStats('copilot').active).toBe(0);
  });

  it('uses independent slot pools per provider key', async () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit('copilot', 1);
    limiter.setLimit('cursor', 1);

    const copilotRelease = await limiter.acquire('copilot');
    // cursor slot should still be immediately available despite copilot being full.
    const cursorRelease = await limiter.acquire('cursor');

    expect(limiter.getStats('copilot').active).toBe(1);
    expect(limiter.getStats('cursor').active).toBe(1);

    copilotRelease();
    cursorRelease();
  });

  it('the release function is idempotent — double-call does not over-release', async () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit('copilot', 1);

    const release = await limiter.acquire('copilot');
    release();
    release(); // no-op

    expect(limiter.getStats('copilot').active).toBe(0);

    // A fresh acquire should still succeed immediately (no under-flow corruption).
    const r2 = await limiter.acquire('copilot');
    expect(limiter.getStats('copilot').active).toBe(1);
    r2();
  });

  it('setLimit raising the cap wakes pending waiters', async () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit('copilot', 1);

    const r1 = await limiter.acquire('copilot');
    let waiterResolved = false;
    const waiter = limiter.acquire('copilot').then((release) => {
      waiterResolved = true;
      return release;
    });

    // Tick to let the waiter register.
    await Promise.resolve();
    expect(waiterResolved).toBe(false);

    limiter.setLimit('copilot', 2);
    const r2 = await waiter;
    expect(waiterResolved).toBe(true);

    r1();
    r2();
  });

  it('rejects invalid limits', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    expect(() => limiter.setLimit('copilot', 0)).toThrow(/>= 1/);
    expect(() => limiter.setLimit('copilot', -1)).toThrow(/>= 1/);
    expect(() => limiter.setLimit('copilot', Number.NaN)).toThrow(/>= 1/);
    expect(() => limiter.setLimit('copilot', Infinity)).toThrow(/>= 1/);
  });

  it('uses the default cap for unknown providers', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    const stats = limiter.getStats('brand-new-provider');
    expect(stats.limit).toBeGreaterThanOrEqual(1);
    expect(stats.active).toBe(0);
    expect(stats.waiting).toBe(0);
  });

  it('applies a 10-slot Copilot default for higher parallel fan-out', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    const copilot = limiter.getStats('copilot');
    const claude = limiter.getStats('claude');
    const gemini = limiter.getStats('gemini');
    const cursor = limiter.getStats('cursor');

    expect(copilot.limit).toBe(10);
    expect(claude.limit).toBe(6);
    expect(gemini.limit).toBe(6);
    expect(cursor.limit).toBe(8);
  });

  it('grants overflow slots to loop children after the interactive cap is full', async () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit('cursor', 2);

    const interactive = [
      await limiter.acquire('cursor'),
      await limiter.acquire('cursor'),
    ];
    expect(limiter.getStats('cursor')).toMatchObject({ active: 2, waiting: 0, limit: 2 });

    const overflowA = await limiter.acquire('cursor', { priority: 'overflow' });
    const overflowB = await limiter.acquire('cursor', { priority: 'overflow' });
    expect(limiter.getStats('cursor').active).toBe(4);

    // The overflow rule widens this wait's cap to 2 + 2, and the message reports that real figure.
    await expect(
      limiter.acquire('cursor', { priority: 'overflow', timeoutMs: 20 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Cursor is already running its maximum of 4 sessions'),
      provider: 'cursor',
      maxSessions: 4,
    });

    overflowB();
    overflowA();
    interactive[1]();
    interactive[0]();
    expect(limiter.getStats('cursor').active).toBe(0);
  });

  it('does not let a normal acquire take overflow slots', async () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit('cursor', 1);

    const held = await limiter.acquire('cursor');
    await expect(limiter.acquire('cursor', { timeoutMs: 20 })).rejects.toMatchObject({
      message: expect.stringContaining('Cursor is already running its maximum of'),
      maxSessions: 1,
    });
    const overflow = await limiter.acquire('cursor', { priority: 'overflow' });
    expect(limiter.getStats('cursor').active).toBe(2);
    overflow();
    held();
  });
});

describe('ProviderConcurrencyLimiter slot timeout', () => {
  beforeEach(() => {
    ProviderConcurrencyLimiter._resetForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    ProviderConcurrencyLimiter._resetForTesting();
  });

  /** Saturate a provider, wait for `waitMs`, and return what the waiter was rejected with. */
  async function timeOut(provider: string, limit: number, waitMs: number): Promise<unknown> {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    limiter.setLimit(provider, limit);
    for (let slot = 0; slot < limit; slot += 1) await limiter.acquire(provider);
    const outcome = limiter.acquire(provider, { timeoutMs: waitMs })
      .then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(waitMs);
    return outcome;
  }

  it('tells the user in plain words which provider is full, its real maximum and how long this one waited', async () => {
    const error = await timeOut('opencode', 20, 60_000) as Error;
    expect(error.message).toContain('OpenCode is already running its maximum of 20 sessions; this one waited a minute.');
    expect(error.message).toMatch(/What to do:/);
    expect(error.message).not.toMatch(/Timed out waiting|provider concurrency slot|60000ms/);
  });

  it('reports the wait that really happened, not a fixed one-minute claim', async () => {
    const error = await timeOut('codex', 3, 12_000) as Error;
    expect(error.message).toContain('Codex is already running its maximum of 3 sessions; this one waited 12 seconds.');
  });

  it('carries the structured figures and the original wording for Details', async () => {
    const error = await timeOut('claude', 2, 30_000) as Error & Record<string, unknown>;
    expect(error).toMatchObject({
      name: 'ProviderConcurrencyTimeoutError',
      code: 'concurrency',
      provider: 'claude',
      maxSessions: 2,
      waitedMs: 30_000,
    });
    expect(error['errorPresentation']).toMatchObject({
      category: 'concurrency',
      action: 'retry',
      rawDetail: "Timed out waiting 30000ms for 'claude' provider concurrency slot",
    });
  });

  it('is still classified as a timeout by the loop and failover retry logic, whatever the wording', async () => {
    const error = await timeOut('opencode', 1, 5_000);
    expect(error).toBeInstanceOf(FailoverError);
    expect(classifyLoopError(error)).toMatchObject({ reason: 'timeout', axes: { retryable: true } });
    expect(coerceToFailoverError(error)?.reason).toBe('timeout');
  });

  it('does not name a provider it does not know', async () => {
    const error = await timeOut('PRIVATE_PROVIDER_KEY', 1, 5_000) as Error & { provider: string };
    expect(error.message).not.toContain('PRIVATE_PROVIDER_KEY');
    expect(error.provider).toBe('PRIVATE_PROVIDER_KEY');
  });
});
