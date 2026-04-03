import { describe, it, expect, vi } from 'vitest';
import { sequential, keyedSequential, createMutex } from '../sequential';

describe('sequential()', () => {
  it('serializes concurrent calls', async () => {
    const order: number[] = [];

    const fn = sequential(async (n: number) => {
      order.push(n);
      await new Promise(r => setTimeout(r, 10));
      order.push(n * 10);
      return n;
    });

    const [r1, r2, r3] = await Promise.all([fn(1), fn(2), fn(3)]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('preserves return values', async () => {
    const fn = sequential(async (x: string) => `result:${x}`);

    const result = await fn('hello');
    expect(result).toBe('result:hello');
  });

  it('propagates errors without blocking the queue', async () => {
    const fn = sequential(async (shouldFail: boolean) => {
      if (shouldFail) throw new Error('boom');
      return 'ok';
    });

    await expect(fn(true)).rejects.toThrow('boom');
    const result = await fn(false);
    expect(result).toBe('ok');
  });

  it('handles void-returning async functions', async () => {
    let called = false;
    const fn = sequential(async () => {
      called = true;
    });

    await fn();
    expect(called).toBe(true);
  });
});

describe('keyedSequential()', () => {
  it('serializes calls with the same key', async () => {
    const order: string[] = [];

    const fn = keyedSequential(async (key: string, value: string) => {
      order.push(`start:${key}:${value}`);
      await new Promise(r => setTimeout(r, 10));
      order.push(`end:${key}:${value}`);
      return value;
    });

    const [r1, r2] = await Promise.all([fn('a', 'first'), fn('a', 'second')]);

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(order).toEqual([
      'start:a:first', 'end:a:first',
      'start:a:second', 'end:a:second',
    ]);
  });

  it('allows concurrent execution for different keys', async () => {
    const order: string[] = [];

    const fn = keyedSequential(async (key: string, value: string) => {
      order.push(`start:${key}:${value}`);
      await new Promise(r => setTimeout(r, 10));
      order.push(`end:${key}:${value}`);
      return value;
    });

    await Promise.all([fn('a', '1'), fn('b', '2')]);

    expect(order[0]).toBe('start:a:1');
    expect(order[1]).toBe('start:b:2');
  });

  it('cleans up idle key chains', async () => {
    vi.useFakeTimers();

    const fn = keyedSequential(
      async (key: string) => key,
      { idleCleanupMs: 100 },
    );

    await fn('temp-key');

    await vi.advanceTimersByTimeAsync(200);

    const result = await fn('temp-key');
    expect(result).toBe('temp-key');

    vi.useRealTimers();
  });

  it('propagates errors without blocking the key queue', async () => {
    const fn = keyedSequential(async (key: string, shouldFail: boolean) => {
      if (shouldFail) throw new Error(`fail:${key}`);
      return `ok:${key}`;
    });

    await expect(fn('a', true)).rejects.toThrow('fail:a');
    const result = await fn('a', false);
    expect(result).toBe('ok:a');
  });
});

describe('createMutex()', () => {
  it('allows single acquisition', async () => {
    const mutex = createMutex();

    expect(mutex.isLocked()).toBe(false);
    const release = await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);
    release();
    expect(mutex.isLocked()).toBe(false);
  });

  it('queues concurrent acquisitions', async () => {
    const mutex = createMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire();
    order.push(1);

    const promise2 = mutex.acquire().then(release => {
      order.push(2);
      return release;
    });

    release1();
    const release2 = await promise2;
    release2();

    expect(order).toEqual([1, 2]);
  });

  it('is safe to release multiple times', async () => {
    const mutex = createMutex();
    const release = await mutex.acquire();

    release();
    release();

    expect(mutex.isLocked()).toBe(false);
  });
});
