import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PriorityMessageQueue, type PriorityMessage, type MessagePriority } from '../priority-queue';

function msg(
  id: string,
  priority: MessagePriority,
  payload: string = id,
  overrides: Partial<PriorityMessage> = {},
): PriorityMessage {
  return { id, priority, payload, timestamp: Date.now(), ...overrides };
}

describe('PriorityMessageQueue', () => {
  let queue: PriorityMessageQueue;

  beforeEach(() => {
    queue = new PriorityMessageQueue();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enqueue / dequeue ordering', () => {
    it('dequeues higher priority messages before lower priority ones', () => {
      queue.enqueue(msg('a', 'later'));
      queue.enqueue(msg('b', 'now'));
      queue.enqueue(msg('c', 'next'));

      expect(queue.dequeue()?.id).toBe('b');    // now first
      expect(queue.dequeue()?.id).toBe('c');    // next second
      expect(queue.dequeue()?.id).toBe('a');    // later last
    });

    it('maintains FIFO order within the same priority', () => {
      queue.enqueue(msg('x1', 'next'));
      queue.enqueue(msg('x2', 'next'));
      queue.enqueue(msg('x3', 'next'));

      expect(queue.dequeue()?.id).toBe('x1');
      expect(queue.dequeue()?.id).toBe('x2');
      expect(queue.dequeue()?.id).toBe('x3');
    });

    it('returns undefined when queue is empty', () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it('mixes priorities correctly across multiple enqueues', () => {
      queue.enqueue(msg('later1', 'later'));
      queue.enqueue(msg('now1', 'now'));
      queue.enqueue(msg('next1', 'next'));
      queue.enqueue(msg('now2', 'now'));
      queue.enqueue(msg('later2', 'later'));

      const order = [];
      let m;
      while ((m = queue.dequeue())) order.push(m.id);

      expect(order).toEqual(['now1', 'now2', 'next1', 'later1', 'later2']);
    });
  });

  describe('peek()', () => {
    it('returns the next message without removing it', () => {
      queue.enqueue(msg('a', 'now'));
      expect(queue.peek()?.id).toBe('a');
      expect(queue.size()).toBe(1); // Still in queue
    });

    it('returns undefined when empty', () => {
      expect(queue.peek()).toBeUndefined();
    });
  });

  describe('size()', () => {
    it('tracks total count across all buckets', () => {
      queue.enqueue(msg('a', 'now'));
      queue.enqueue(msg('b', 'next'));
      queue.enqueue(msg('c', 'later'));
      expect(queue.size()).toBe(3);
      queue.dequeue();
      expect(queue.size()).toBe(2);
    });
  });

  describe('clear()', () => {
    it('removes all messages from all buckets', () => {
      queue.enqueue(msg('a', 'now'));
      queue.enqueue(msg('b', 'next'));
      queue.clear();
      expect(queue.size()).toBe(0);
      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe('drain()', () => {
    it('returns all messages in priority order and empties the queue', () => {
      queue.enqueue(msg('later1', 'later'));
      queue.enqueue(msg('now1', 'now'));
      queue.enqueue(msg('next1', 'next'));

      const drained = queue.drain();
      expect(drained.map(m => m.id)).toEqual(['now1', 'next1', 'later1']);
      expect(queue.size()).toBe(0);
    });

    it('returns empty array when queue is empty', () => {
      expect(queue.drain()).toEqual([]);
    });
  });

  describe('TTL / expiry', () => {
    it('skips expired messages during dequeue', () => {
      const pastExpiry = Date.now() - 1000; // already expired
      queue.enqueue(msg('expired', 'now', 'expired', { expiresAt: pastExpiry }));
      queue.enqueue(msg('fresh', 'now'));

      expect(queue.dequeue()?.id).toBe('fresh');
      expect(queue.dequeue()).toBeUndefined();
    });

    it('dequeues a message before its expiry', () => {
      const futureExpiry = Date.now() + 5000;
      queue.enqueue(msg('valid', 'now', 'valid', { expiresAt: futureExpiry }));
      expect(queue.dequeue()?.id).toBe('valid');
    });

    it('drain() excludes expired messages', () => {
      const pastExpiry = Date.now() - 1;
      queue.enqueue(msg('expired', 'next', 'expired', { expiresAt: pastExpiry }));
      queue.enqueue(msg('fresh', 'next'));
      const drained = queue.drain();
      expect(drained.map(m => m.id)).toEqual(['fresh']);
    });
  });
});
