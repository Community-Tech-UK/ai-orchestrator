/**
 * Session Persistence Queue
 *
 * Batches session event-log appends and coalesces per-instance state saves.
 * Both operations are moved off the provider-event hot path via a bounded
 * async queue with a short flush window.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { BoundedAsyncQueue } from '../runtime/bounded-async-queue';

const FLUSH_INTERVAL_MS = 200;

interface EventEntry {
  logPath: string;
  line: string;
}

type PersistenceTask =
  | { kind: 'event-batch'; entries: EventEntry[] }
  | { kind: 'state-save'; instanceId: string; saveFn: () => Promise<void>; onError: (err: unknown) => void };

export class SessionPersistenceQueue {
  private readonly queue: BoundedAsyncQueue<PersistenceTask>;

  private pendingEvents: EventEntry[] = [];
  private pendingSaves = new Map<string, {
    saveFn: () => Promise<void>;
    onError: (err: unknown) => void;
  }>();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.queue = new BoundedAsyncQueue<PersistenceTask>({
      name: 'session-persistence',
      maxSize: 1_000,
      concurrency: 1,
      process: (task) => this.processTask(task),
      onDrop: () => { /* non-critical */ },
    });
  }

  enqueueEvent(logPath: string, line: string): void {
    this.pendingEvents.push({ logPath, line });
    this.scheduleFlush();
  }

  enqueueSave(
    instanceId: string,
    saveFn: () => Promise<void>,
    onError: (err: unknown) => void,
  ): void {
    // Coalesce: replace any pending save for this instance — the in-memory
    // state already holds the latest value, so a single save is sufficient.
    this.pendingSaves.set(instanceId, { saveFn, onError });
    this.scheduleFlush();
  }

  metrics() {
    return this.queue.metrics();
  }

  async shutdown({ drain }: { drain: boolean }): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    await this.queue.shutdown({ drain });
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  private flush(): void {
    if (this.pendingEvents.length > 0) {
      const entries = this.pendingEvents;
      this.pendingEvents = [];
      this.queue.enqueue({ kind: 'event-batch', entries });
    }

    for (const [instanceId, save] of this.pendingSaves) {
      this.queue.enqueue({ kind: 'state-save', instanceId, ...save });
    }
    this.pendingSaves.clear();
  }

  private async processTask(task: PersistenceTask): Promise<void> {
    if (task.kind === 'event-batch') {
      // Group by log path so we open each file only once per batch.
      const byPath = new Map<string, string[]>();
      for (const { logPath, line } of task.entries) {
        const existing = byPath.get(logPath);
        if (existing) {
          existing.push(line);
        } else {
          byPath.set(logPath, [line]);
        }
      }
      for (const [logPath, lines] of byPath) {
        try {
          await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
          await fsPromises.appendFile(logPath, lines.join('\n') + '\n', 'utf-8');
        } catch { /* non-critical */ }
      }
      return;
    }

    if (task.kind === 'state-save') {
      try {
        await task.saveFn();
      } catch (err) {
        task.onError(err);
      }
    }
  }
}

let sharedQueue: SessionPersistenceQueue | null = null;

export function getSessionPersistenceQueue(): SessionPersistenceQueue {
  if (!sharedQueue) {
    sharedQueue = new SessionPersistenceQueue();
  }
  return sharedQueue;
}

export function _resetSessionPersistenceQueueForTesting(): void {
  sharedQueue = null;
}
