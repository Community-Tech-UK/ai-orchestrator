import { describe, it, expect, vi } from 'vitest';
import { BoundedAsyncQueue } from '../bounded-async-queue';

describe('BoundedAsyncQueue', () => {
  it('processes items in FIFO order at concurrency 1', async () => {
    const order: number[] = [];
    const queue = new BoundedAsyncQueue<number>({
      name: 'test-fifo',
      maxSize: 10,
      concurrency: 1,
      process: async (n) => {
        order.push(n);
      },
    });

    for (let i = 0; i < 5; i++) {
      queue.enqueue(i);
    }
    await queue.flush();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('processes items with concurrency > 1', async () => {
    const processed: number[] = [];
    const queue = new BoundedAsyncQueue<number>({
      name: 'test-concurrent',
      maxSize: 20,
      concurrency: 4,
      process: async (n) => {
        processed.push(n);
      },
    });

    for (let i = 0; i < 8; i++) {
      queue.enqueue(i);
    }
    await queue.flush();
    expect(processed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(queue.metrics().processed).toBe(8);
  });

  it('drops items when capacity is exceeded', () => {
    const dropped: number[] = [];
    const queue = new BoundedAsyncQueue<number>({
      name: 'test-capacity',
      maxSize: 3,
      concurrency: 0, // won't start processing without schedule
      process: async () => { /* no-op */ },
      onDrop: (item) => { dropped.push(item); },
    });

    // Concurrency 0 means nothing drains, so queue fills
    // Use a blocking process function to prevent draining
    const blocking = new BoundedAsyncQueue<number>({
      name: 'test-capacity-blocking',
      maxSize: 2,
      concurrency: 1,
      process: () => new Promise(() => { /* never resolves */ }),
      onDrop: (item) => { dropped.push(item); },
    });

    // First fills inFlight
    blocking.enqueue(0); // goes inFlight immediately
    blocking.enqueue(1); // queued
    blocking.enqueue(2); // queued (maxSize=2, one inFlight, one queued)

    // This one should exceed capacity
    const result = blocking.enqueue(3);
    expect(result).toEqual({ accepted: false, reason: 'capacity' });
    expect(dropped).toContain(3);
    expect(blocking.metrics().dropped).toBe(1);
  });

  it('exposes metrics correctly', async () => {
    const resolvers: Array<() => void> = [];
    const queue = new BoundedAsyncQueue<string>({
      name: 'test-metrics',
      maxSize: 5,
      concurrency: 1,
      process: () => new Promise<void>((res) => { resolvers.push(res); }),
    });

    queue.enqueue('a');
    queue.enqueue('b');

    // Give microtasks a chance to start processing 'a'
    await Promise.resolve();
    await Promise.resolve();

    const m = queue.metrics();
    expect(m.inFlight).toBe(1);
    expect(m.queued).toBe(1);
    expect(m.processed).toBe(0);

    // Resolve all pending items (first 'a', then 'b')
    resolvers[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    resolvers[1]?.();

    await queue.flush();

    const m2 = queue.metrics();
    expect(m2.processed).toBe(2);
    expect(m2.inFlight).toBe(0);
    expect(m2.queued).toBe(0);
  });

  it('shutdown without drain drops remaining items', async () => {
    const dropped: string[] = [];
    const queue = new BoundedAsyncQueue<string>({
      name: 'test-shutdown-nodrain',
      maxSize: 10,
      concurrency: 1,
      process: () => new Promise(() => { /* never resolves */ }),
      onDrop: (item) => { dropped.push(item); },
    });

    queue.enqueue('first'); // goes inFlight immediately
    queue.enqueue('second'); // queued
    queue.enqueue('third'); // queued

    await queue.shutdown({ drain: false });

    expect(dropped).toContain('second');
    expect(dropped).toContain('third');
    expect(queue.metrics().dropped).toBeGreaterThanOrEqual(2);
  });

  it('shutdown with drain waits for existing work', async () => {
    const processed: number[] = [];
    const queue = new BoundedAsyncQueue<number>({
      name: 'test-shutdown-drain',
      maxSize: 10,
      concurrency: 2,
      process: async (n) => {
        await new Promise((r) => setTimeout(r, 1));
        processed.push(n);
      },
    });

    for (let i = 0; i < 4; i++) queue.enqueue(i);

    await queue.shutdown({ drain: true });
    expect(processed.length).toBe(4);
  });

  it('enqueue after shutdown returns shutdown reason', () => {
    const queue = new BoundedAsyncQueue<number>({
      name: 'test-post-shutdown',
      maxSize: 10,
      concurrency: 1,
      process: async () => { /* no-op */ },
    });

    void queue.shutdown({ drain: false });
    const result = queue.enqueue(99);
    expect(result).toEqual({ accepted: false, reason: 'shutdown' });
  });

  it('flush resolves immediately when queue is empty', async () => {
    const queue = new BoundedAsyncQueue<void>({
      name: 'test-flush-empty',
      maxSize: 5,
      concurrency: 1,
      process: async () => { /* no-op */ },
    });
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it('flush with timeout resolves even if queue never empties', async () => {
    const queue = new BoundedAsyncQueue<void>({
      name: 'test-flush-timeout',
      maxSize: 5,
      concurrency: 1,
      process: () => new Promise(() => { /* never resolves */ }),
    });
    queue.enqueue();
    await expect(queue.flush(20)).resolves.toBeUndefined();
  });

  it('reports oldestQueuedAgeMs > 0 for queued items', async () => {
    const queue = new BoundedAsyncQueue<void>({
      name: 'test-oldest',
      maxSize: 5,
      concurrency: 1,
      process: () => new Promise(() => { /* never resolves */ }),
    });
    queue.enqueue(); // in flight
    queue.enqueue(); // queued

    await new Promise((r) => setTimeout(r, 5));
    expect(queue.metrics().oldestQueuedAgeMs).toBeGreaterThan(0);
  });

  it('onDrop is called with capacity reason', () => {
    const onDrop = vi.fn();
    const queue = new BoundedAsyncQueue<number>({
      name: 'test-drop-cb',
      maxSize: 1,
      concurrency: 1,
      process: () => new Promise(() => { /* never */ }),
      onDrop,
    });

    queue.enqueue(1); // inFlight immediately
    queue.enqueue(2); // fills maxSize=1 queue slot
    queue.enqueue(3); // exceeds capacity → drop

    expect(onDrop).toHaveBeenCalledWith(3, 'capacity');
  });

  it('failed items increment the failed counter', async () => {
    const queue = new BoundedAsyncQueue<number>({
      name: 'test-failures',
      maxSize: 10,
      concurrency: 1,
      process: async () => {
        throw new Error('boom');
      },
    });

    for (let i = 0; i < 3; i++) queue.enqueue(i);
    await queue.flush();

    expect(queue.metrics().failed).toBe(3);
    expect(queue.metrics().processed).toBe(0);
  });
});
