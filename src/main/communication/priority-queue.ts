/**
 * Priority Message Queue
 *
 * Three-bucket priority queue for inter-instance messages.
 * Priorities: 'now' > 'next' > 'later'. FIFO within each bucket.
 * Supports optional per-message TTL via expiresAt timestamp.
 *
 * Intended as the internal message store for CrossInstanceComm.
 * Standalone — no Electron or Node.js imports required.
 */

export type MessagePriority = 'now' | 'next' | 'later';

export interface PriorityMessage<T = unknown> {
  id: string;
  priority: MessagePriority;
  payload: T;
  timestamp: number;
  /** Optional Unix ms timestamp after which this message is considered stale. */
  expiresAt?: number;
}

const PRIORITY_ORDER: MessagePriority[] = ['now', 'next', 'later'];

export class PriorityMessageQueue<T = unknown> {
  private buckets = new Map<MessagePriority, PriorityMessage<T>[]>([
    ['now', []],
    ['next', []],
    ['later', []],
  ]);

  enqueue(msg: PriorityMessage<T>): void {
    this.buckets.get(msg.priority)!.push(msg);
  }

  /**
   * Dequeue the highest-priority non-expired message.
   * Expired messages are silently discarded.
   */
  dequeue(): PriorityMessage<T> | undefined {
    const now = Date.now();
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.buckets.get(priority)!;
      while (bucket.length > 0) {
        const candidate = bucket.shift()!;
        if (candidate.expiresAt !== undefined && candidate.expiresAt <= now) {
          continue; // Discard expired
        }
        return candidate;
      }
    }
    return undefined;
  }

  peek(): PriorityMessage<T> | undefined {
    const now = Date.now();
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.buckets.get(priority)!;
      for (const msg of bucket) {
        if (msg.expiresAt === undefined || msg.expiresAt > now) {
          return msg;
        }
      }
    }
    return undefined;
  }

  size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      total += bucket.length;
    }
    return total;
  }

  clear(): void {
    for (const bucket of this.buckets.values()) {
      bucket.length = 0;
    }
  }

  /** Return all non-expired messages in priority order, emptying the queue. */
  drain(): PriorityMessage<T>[] {
    const now = Date.now();
    const result: PriorityMessage<T>[] = [];
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.buckets.get(priority)!;
      for (const msg of bucket) {
        if (msg.expiresAt === undefined || msg.expiresAt > now) {
          result.push(msg);
        }
      }
      bucket.length = 0;
    }
    return result;
  }
}
