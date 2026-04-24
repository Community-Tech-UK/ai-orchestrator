import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionMutex } from './session-mutex';

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
});
