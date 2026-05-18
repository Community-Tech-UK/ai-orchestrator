import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyedCoalescingWorker } from './keyed-coalescing-worker';

describe('KeyedCoalescingWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the worker function with the pushed value', async () => {
    const calls: [string, number][] = [];
    const worker = new KeyedCoalescingWorker<string, number>(async (k, v) => {
      calls.push([k, v]);
    });

    worker.push('a', 1);
    await worker.drainAll();

    expect(calls).toEqual([['a', 1]]);
  });

  it('latest value wins — coalesces rapid pushes to the same key', async () => {
    const calls: [string, number][] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (k, v) => { calls.push([k, v]); },
      { debounceMs: 50 },
    );

    worker.push('a', 1);
    worker.push('a', 2);
    worker.push('a', 3);

    await vi.advanceTimersByTimeAsync(100);
    await worker.drainAll();

    // Only the latest value (3) should be processed.
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['a', 3]);
  });

  it('different keys run independently', async () => {
    const calls: [string, number][] = [];
    const worker = new KeyedCoalescingWorker<string, number>(async (k, v) => {
      calls.push([k, v]);
    });

    worker.push('a', 1);
    worker.push('b', 2);
    await worker.drainAll();

    expect(calls).toContainEqual(['a', 1]);
    expect(calls).toContainEqual(['b', 2]);
  });

  it('drain resolves after the in-flight run finishes', async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => { resolve = r; });
    const worker = new KeyedCoalescingWorker<string, string>(async () => {
      await blocker;
    });

    worker.push('key', 'value');

    let drained = false;
    void worker.drain('key').then(() => { drained = true; });

    // Not yet drained — blocker is still pending
    await Promise.resolve();
    expect(drained).toBe(false);

    resolve();
    await worker.drainAll();
    expect(drained).toBe(true);
  });

  it('drainAll resolves when all keys are idle', async () => {
    const order: string[] = [];
    const worker = new KeyedCoalescingWorker<string, string>(async (k) => {
      order.push(k);
    });

    worker.push('a', 'va');
    worker.push('b', 'vb');
    worker.push('c', 'vc');

    await worker.drainAll();

    expect(order).toContain('a');
    expect(order).toContain('b');
    expect(order).toContain('c');
  });

  it('debounce timer extends on rapid pushes', async () => {
    const calls: number[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (_, v) => { calls.push(v); },
      { debounceMs: 100 },
    );

    worker.push('k', 1);
    await vi.advanceTimersByTimeAsync(50);
    worker.push('k', 2); // resets the debounce
    await vi.advanceTimersByTimeAsync(50);

    // Debounce not yet expired — no calls yet
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    await worker.drainAll();

    expect(calls).toEqual([2]);
  });

  it('worker errors do not break subsequent pushes', async () => {
    let shouldThrow = true;
    const calls: number[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(async (_, v) => {
      if (shouldThrow) throw new Error('boom');
      calls.push(v);
    });

    worker.push('k', 1);
    await worker.drainAll();

    shouldThrow = false;
    worker.push('k', 2);
    await worker.drainAll();

    expect(calls).toEqual([2]);
  });

  it('activeKeyCount reflects pending/in-flight keys', async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => { resolve = r; });
    const worker = new KeyedCoalescingWorker<string, number>(async () => {
      await blocker;
    });

    expect(worker.activeKeyCount).toBe(0);

    worker.push('a', 1);
    expect(worker.activeKeyCount).toBe(1);

    resolve();
    await worker.drainAll();
    expect(worker.activeKeyCount).toBe(0);
  });
});
