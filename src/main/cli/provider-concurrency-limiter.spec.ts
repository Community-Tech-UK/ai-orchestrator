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

import { ProviderConcurrencyLimiter } from './provider-concurrency-limiter';

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

  it('applies tighter Copilot default than Claude/Codex/Gemini', () => {
    const limiter = ProviderConcurrencyLimiter.getInstance();
    const copilot = limiter.getStats('copilot');
    const claude = limiter.getStats('claude');
    const gemini = limiter.getStats('gemini');

    expect(copilot.limit).toBe(3);
    expect(claude.limit).toBe(6);
    expect(gemini.limit).toBe(6);
  });
});
