import { describe, it, expect } from 'vitest';
import { DrainableQueue, KeyedCoalescingQueue } from '../drainable-queue';

// ── Helpers ─────────────────────────────────────────────────────

/** Returns a processor that records calls and optionally delays. */
function trackingProcessor(delayMs = 0) {
  const calls: string[] = [];
  const processor = async (item: string): Promise<void> => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    calls.push(item);
  };
  return { calls, processor };
}

/** Deferred promise — resolve/reject from outside. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── DrainableQueue ──────────────────────────────────────────────

describe('DrainableQueue', () => {
  describe('basic processing', () => {
    it('processes all enqueued items', async () => {
      const { calls, processor } = trackingProcessor();
      const queue = new DrainableQueue(processor);

      queue.enqueue('a');
      queue.enqueue('b');
      queue.enqueue('c');
      await queue.drain();

      expect(calls).toEqual(['a', 'b', 'c']);
    });

    it('drain() resolves immediately when queue is empty', async () => {
      const queue = new DrainableQueue(async () => { /* noop */ });
      await queue.drain(); // Should not hang
    });

    it('enqueueAll processes multiple items', async () => {
      const { calls, processor } = trackingProcessor();
      const queue = new DrainableQueue(processor);

      queue.enqueueAll(['x', 'y', 'z']);
      await queue.drain();

      expect(calls).toEqual(['x', 'y', 'z']);
    });
  });

  describe('concurrency control', () => {
    it('concurrency=1 processes items sequentially', async () => {
      const order: string[] = [];
      const gates: Record<string, ReturnType<typeof deferred>> = {};

      const queue = new DrainableQueue<string>(async (item) => {
        const gate = deferred();
        gates[item] = gate;
        order.push(`start:${item}`);
        await gate.promise;
        order.push(`end:${item}`);
      }, { concurrency: 1 });

      queue.enqueue('a');
      queue.enqueue('b');

      // Let microtasks run so 'a' starts
      await new Promise((r) => setTimeout(r, 0));
      expect(order).toEqual(['start:a']);
      expect(queue.activeCount).toBe(1);
      expect(queue.pendingCount).toBe(1);

      // Complete 'a' — 'b' should start
      gates['a'].resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(order).toEqual(['start:a', 'end:a', 'start:b']);

      // Complete 'b'
      gates['b'].resolve();
      await queue.drain();
      expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });

    it('concurrency=2 processes up to 2 items in parallel', async () => {
      const active = { count: 0, maxSeen: 0 };
      const queue = new DrainableQueue<string>(async () => {
        active.count++;
        active.maxSeen = Math.max(active.maxSeen, active.count);
        await new Promise((r) => setTimeout(r, 10));
        active.count--;
      }, { concurrency: 2 });

      queue.enqueueAll(['a', 'b', 'c', 'd']);
      await queue.drain();

      expect(active.maxSeen).toBe(2);
    });

    it('unlimited concurrency processes all items immediately', async () => {
      const active = { count: 0, maxSeen: 0 };
      const queue = new DrainableQueue<string>(async () => {
        active.count++;
        active.maxSeen = Math.max(active.maxSeen, active.count);
        await new Promise((r) => setTimeout(r, 10));
        active.count--;
      });

      queue.enqueueAll(['a', 'b', 'c', 'd']);
      await queue.drain();

      expect(active.maxSeen).toBe(4);
    });
  });

  describe('error handling', () => {
    it('drain() rejects with AggregateError when processor throws', async () => {
      const queue = new DrainableQueue<string>(async (item) => {
        if (item === 'bad') throw new Error('boom');
      });

      queue.enqueue('good');
      queue.enqueue('bad');

      await expect(queue.drain()).rejects.toThrow('DrainableQueue: 1 processor error(s)');
    });

    it('processes remaining items after an error', async () => {
      const { calls, processor: baseProcessor } = trackingProcessor();
      const queue = new DrainableQueue<string>(async (item) => {
        if (item === 'bad') throw new Error('boom');
        await baseProcessor(item);
      });

      queue.enqueueAll(['a', 'bad', 'b']);

      try {
        await queue.drain();
      } catch {
        // Expected
      }

      // 'a' and 'b' should still have been processed
      expect(calls).toEqual(['a', 'b']);
    });

    it('drainSilent() resolves without throwing on errors', async () => {
      const queue = new DrainableQueue<string>(async (item) => {
        if (item === 'bad') throw new Error('boom');
      });

      queue.enqueue('bad');

      await queue.drainSilent(); // Should not throw
      expect(queue.stats().totalErrored).toBe(1);
    });
  });

  describe('stats and state', () => {
    it('tracks stats correctly', async () => {
      const queue = new DrainableQueue<string>(async () => { /* noop */ });

      queue.enqueue('a');
      queue.enqueue('b');
      await queue.drain();

      const stats = queue.stats();
      expect(stats.totalEnqueued).toBe(2);
      expect(stats.totalCompleted).toBe(2);
      expect(stats.totalErrored).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.active).toBe(0);
    });

    it('isIdle() reflects queue state', async () => {
      const gate = deferred();
      const queue = new DrainableQueue<string>(async () => {
        await gate.promise;
      });

      expect(queue.isIdle()).toBe(true);

      queue.enqueue('a');
      expect(queue.isIdle()).toBe(false);

      gate.resolve();
      await queue.drain();
      expect(queue.isIdle()).toBe(true);
    });

    it('reset() clears pending items and counters', async () => {
      const { calls, processor } = trackingProcessor();
      const gate = deferred();
      const queue = new DrainableQueue<string>(async (item) => {
        await gate.promise;
        await processor(item);
      }, { concurrency: 1 });

      queue.enqueue('a');
      queue.enqueue('b'); // Will be pending

      // Reset while 'a' is processing and 'b' is pending
      queue.reset();
      expect(queue.pendingCount).toBe(0);
      expect(queue.stats().totalEnqueued).toBe(0);

      gate.resolve();
      await queue.drain();

      // Only 'a' was already active when reset happened
      expect(calls).toEqual(['a']);
    });
  });

  describe('multiple drain() callers', () => {
    it('notifies all callers when work completes', async () => {
      const gate = deferred();
      const queue = new DrainableQueue<string>(async () => {
        await gate.promise;
      });

      queue.enqueue('a');

      const drain1 = queue.drain();
      const drain2 = queue.drain();

      gate.resolve();

      await Promise.all([drain1, drain2]);
    });
  });

  describe('work enqueued during processing', () => {
    it('drain() waits for items enqueued during processing', async () => {
      const calls: string[] = [];
      const ref = { queue: null as DrainableQueue<string> | null };

      ref.queue = new DrainableQueue<string>(async (item) => {
        calls.push(item);
        if (item === 'first') {
          ref.queue!.enqueue('second'); // Enqueue during processing
        }
      });

      ref.queue.enqueue('first');
      await ref.queue.drain();

      expect(calls).toEqual(['first', 'second']);
    });
  });
});

// ── KeyedCoalescingQueue ────────────────────────────────────────

describe('KeyedCoalescingQueue', () => {
  describe('basic processing', () => {
    it('processes enqueued key-value pairs', async () => {
      const calls: [string, number][] = [];
      const queue = new KeyedCoalescingQueue<string, number>(async (key, value) => {
        calls.push([key, value]);
      });

      queue.enqueue('a', 1);
      queue.enqueue('b', 2);
      await queue.drain();

      expect(calls).toEqual([['a', 1], ['b', 2]]);
    });

    it('drain() resolves immediately when idle', async () => {
      const queue = new KeyedCoalescingQueue<string, number>(async () => { /* noop */ });
      await queue.drain(); // Should not hang
    });
  });

  describe('coalescing behavior', () => {
    it('keeps only the latest value when same key is enqueued multiple times', async () => {
      const calls: [string, number][] = [];
      const firstGate = deferred();
      const secondGate = deferred();
      let callCount = 0;

      const queue = new KeyedCoalescingQueue<string, number>(async (key, value) => {
        callCount++;
        if (callCount === 1) await firstGate.promise;
        else await secondGate.promise;
        calls.push([key, value]);
      });

      // First enqueue — starts processing immediately, blocks on firstGate
      queue.enqueue('a', 1);
      await new Promise((r) => setTimeout(r, 0));

      // While 'a' is blocked, enqueue two more values for the same key.
      // Only the latest (3) should be kept.
      queue.enqueue('a', 2);
      queue.enqueue('a', 3);

      // Release first processing
      firstGate.resolve();
      await new Promise((r) => setTimeout(r, 0));

      // Second processing should pick up value=3 (not 2)
      secondGate.resolve();
      await queue.drain();

      expect(calls).toEqual([['a', 1], ['a', 3]]);
    });

    it('processes different keys independently', async () => {
      const calls: [string, number][] = [];
      const queue = new KeyedCoalescingQueue<string, number>(async (key, value) => {
        calls.push([key, value]);
      });

      queue.enqueue('a', 1);
      queue.enqueue('b', 2);
      queue.enqueue('c', 3);
      await queue.drain();

      // Each key processed exactly once
      expect(calls).toHaveLength(3);
      expect(calls.map(([k]) => k).sort()).toEqual(['a', 'b', 'c']);
    });

    it('coalesces same key while blocked, preserving other keys', async () => {
      const calls: [string, number][] = [];
      const gate = deferred();

      const queue = new KeyedCoalescingQueue<string, number>(async (key, value) => {
        // Block on key 'a' the first time
        if (key === 'a' && calls.filter(([k]) => k === 'a').length === 0) {
          await gate.promise;
        }
        calls.push([key, value]);
      });

      // 'a' starts processing immediately (blocked on gate)
      queue.enqueue('a', 1);
      await new Promise((r) => setTimeout(r, 0));

      // While 'a' is blocked, enqueue 'b' (different key — starts immediately)
      // and overwrite 'a' in the pending map
      queue.enqueue('b', 2);
      queue.enqueue('a', 3); // Replaces a=1 in pending (a is still active with 1)

      // Let 'b' complete (it's not blocked)
      await new Promise((r) => setTimeout(r, 0));

      // Release 'a' gate
      gate.resolve();
      await queue.drain();

      // 'a' called twice: once with 1 (in-flight), once with 3 (coalesced)
      // 'b' called once with 2
      const aCalls = calls.filter(([k]) => k === 'a');
      const bCalls = calls.filter(([k]) => k === 'b');
      expect(aCalls).toEqual([['a', 1], ['a', 3]]);
      expect(bCalls).toEqual([['b', 2]]);
    });
  });

  describe('drainKey', () => {
    it('resolves when a specific key has finished processing', async () => {
      const gate = deferred();
      const calls: string[] = [];

      const queue = new KeyedCoalescingQueue<string, string>(async (key, value) => {
        if (key === 'slow') await gate.promise;
        calls.push(value);
      });

      queue.enqueue('fast', 'f1');
      queue.enqueue('slow', 's1');

      // Wait for 'fast' to complete
      await queue.drainKey('fast');
      expect(calls).toContain('f1');

      // Release 'slow'
      gate.resolve();
      await queue.drainKey('slow');
      expect(calls).toContain('s1');
    });

    it('resolves immediately for keys not in the queue', async () => {
      const queue = new KeyedCoalescingQueue<string, string>(async () => { /* noop */ });
      await queue.drainKey('nonexistent'); // Should not hang
    });
  });

  describe('state', () => {
    it('isIdle() reflects queue state', async () => {
      const gate = deferred();
      const queue = new KeyedCoalescingQueue<string, number>(async () => {
        await gate.promise;
      });

      expect(queue.isIdle()).toBe(true);

      queue.enqueue('a', 1);
      expect(queue.isIdle()).toBe(false);

      gate.resolve();
      await queue.drain();
      expect(queue.isIdle()).toBe(true);
    });
  });
});
