import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionMutex, SessionMutexTimeoutError, isSessionMutexTimeout } from './session-mutex';

describe('SessionMutex', () => {
  let mutex: SessionMutex;

  beforeEach(() => {
    mutex = new SessionMutex();
  });

  it('acquires and releases a lock', async () => {
    const release = await mutex.acquire('inst-1', 'test');
    expect(mutex.isLocked('inst-1')).toBe(true);
    release();
    expect(mutex.isLocked('inst-1')).toBe(false);
  });

  it('queues concurrent acquires sequentially', async () => {
    const order: number[] = [];

    const release1 = await mutex.acquire('inst-1', 'first');
    order.push(1);

    const promise2 = mutex.acquire('inst-1', 'second').then(release => {
      order.push(2);
      return release;
    });

    release1();
    const release2 = await promise2;
    release2();

    expect(order).toEqual([1, 2]);
  });

  it('allows locks on different instances concurrently', async () => {
    const release1 = await mutex.acquire('inst-1', 'a');
    const release2 = await mutex.acquire('inst-2', 'b');

    expect(mutex.isLocked('inst-1')).toBe(true);
    expect(mutex.isLocked('inst-2')).toBe(true);

    release1();
    release2();
  });

  it('forceRelease unblocks waiting acquires', async () => {
    const release1 = await mutex.acquire('inst-1', 'holder');

    let resolved = false;
    const promise2 = mutex.acquire('inst-1', 'waiter').then(release => {
      resolved = true;
      return release;
    });

    mutex.forceRelease('inst-1');

    const release2 = await promise2;
    expect(resolved).toBe(true);
    release2();
  });

  it('getLockInfo returns holder info', async () => {
    const release = await mutex.acquire('inst-1', 'test-source', {
      operation: 'restart',
      recoveryReason: 'restart',
      turnId: 'turn-1',
      adapterGeneration: 4,
    });
    const info = mutex.getLockInfo('inst-1');

    expect(info).not.toBeNull();
    expect(info!.source).toBe('test-source');
    expect(info!.owner).toMatchObject({
      operation: 'restart',
      recoveryReason: 'restart',
      turnId: 'turn-1',
      adapterGeneration: 4,
    });
    expect(info!.durationMs).toBeGreaterThanOrEqual(0);

    release();
    expect(mutex.getLockInfo('inst-1')).toBeNull();
  });

  it('returns null for unlocked instance', () => {
    expect(mutex.isLocked('nonexistent')).toBe(false);
    expect(mutex.getLockInfo('nonexistent')).toBeNull();
  });

  describe('acquire timeout (C3 — SessionMutexTimeoutError)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('throws SessionMutexTimeoutError when lock is held past the timeout', async () => {
      const release = await mutex.acquire('inst-1', 'holder');

      // Attach the catch before advancing timers to avoid
      // "rejection handled asynchronously" warnings from Node.js timing.
      let caught: unknown;
      const waiterPromise = mutex.acquire('inst-1', 'waiter', undefined, 5_000)
        .catch((err) => { caught = err; });

      await vi.advanceTimersByTimeAsync(5_001);
      await waiterPromise;

      expect(caught).toBeInstanceOf(SessionMutexTimeoutError);
      expect(caught).toMatchObject({
        instanceId: 'inst-1',
        waitingSource: 'waiter',
        timeoutMs: 5_000,
      });

      release();
    });

    it('SessionMutexTimeoutError includes holder info for diagnostics', async () => {
      const release = await mutex.acquire('inst-1', 'slow-holder', {
        operation: 'respawn',
        recoveryReason: 'unexpected-exit',
        turnId: 'turn-42',
        adapterGeneration: 2,
      });

      // Attach the catch handler before advancing timers to avoid
      // "rejection handled asynchronously" from Node.js timing.
      let caughtError: unknown;
      const waiterPromise = mutex.acquire('inst-1', 'waiter', undefined, 1_000)
        .catch((err) => { caughtError = err; });

      await vi.advanceTimersByTimeAsync(1_001);
      await waiterPromise; // waiterPromise now resolves (catch absorbs rejection)

      expect(caughtError).toBeInstanceOf(SessionMutexTimeoutError);
      const err = caughtError as SessionMutexTimeoutError;
      expect(err.holderInfo?.source).toBe('slow-holder');
      expect(err.holderInfo?.owner?.operation).toBe('respawn');

      release();
    });

    it('isSessionMutexTimeout identifies the error', async () => {
      const err = new SessionMutexTimeoutError('inst-1', 'src', 1_000);
      expect(isSessionMutexTimeout(err)).toBe(true);
      expect(isSessionMutexTimeout(new Error('other'))).toBe(false);
      expect(isSessionMutexTimeout(null)).toBe(false);
    });

    it('resolves normally when lock is released before timeout fires', async () => {
      const release1 = await mutex.acquire('inst-1', 'first');

      const waiterPromise = mutex.acquire('inst-1', 'second', undefined, 5_000);

      // Release before timeout fires (only 1ms passes)
      await vi.advanceTimersByTimeAsync(1);
      release1();

      const release2 = await waiterPromise;
      expect(mutex.isLocked('inst-1')).toBe(true);
      release2();
    });

    it('timeoutMs=0 waits indefinitely without throwing', async () => {
      const release1 = await mutex.acquire('inst-1', 'first');

      let acquired = false;
      const waiterPromise = mutex.acquire('inst-1', 'waiter', undefined, 0).then(r => {
        acquired = true;
        return r;
      });

      // Advance well past any typical timeout — should not throw
      await vi.advanceTimersByTimeAsync(300_000);
      expect(acquired).toBe(false);

      release1();
      const release2 = await waiterPromise;
      expect(acquired).toBe(true);
      release2();
    });
  });
});
