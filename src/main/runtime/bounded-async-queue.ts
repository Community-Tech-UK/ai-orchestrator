/**
 * Bounded Async Queue
 *
 * A FIFO async processing queue with configurable:
 * - Max capacity (drops new items when full, per policy)
 * - Concurrency (number of items processed in parallel)
 * - Drop callback for observability
 * - Metrics (queued, inFlight, processed, failed, dropped, oldestQueuedAgeMs)
 * - flush() and shutdown()
 *
 * Critical use: set maxSize high and onDrop to throw/log — never silently drop.
 * Low-priority use: set maxSize low, coalesce before enqueue.
 */

export interface BoundedAsyncQueueOptions<T> {
  name: string;
  maxSize: number;
  concurrency?: number;
  process: (item: T) => Promise<void> | void;
  onDrop?: (item: T, reason: 'capacity' | 'shutdown') => void;
}

export type EnqueueResult =
  | { accepted: true }
  | { accepted: false; reason: 'capacity' | 'shutdown' };

export interface BoundedAsyncQueueMetrics {
  queued: number;
  inFlight: number;
  processed: number;
  failed: number;
  dropped: number;
  oldestQueuedAgeMs: number;
}

interface QueueEntry<T> {
  item: T;
  enqueuedAt: number;
}

export class BoundedAsyncQueue<T> {
  private readonly name: string;
  private readonly maxSize: number;
  private readonly concurrency: number;
  private readonly processItem: (item: T) => Promise<void> | void;
  private readonly onDrop?: (item: T, reason: 'capacity' | 'shutdown') => void;

  private queue: QueueEntry<T>[] = [];
  private inFlight = 0;
  private processed = 0;
  private failed = 0;
  private dropped = 0;
  private shutdownCalled = false;
  private flushResolvers: Array<() => void> = [];

  constructor(options: BoundedAsyncQueueOptions<T>) {
    this.name = options.name;
    this.maxSize = options.maxSize;
    this.concurrency = options.concurrency ?? 1;
    this.processItem = options.process;
    this.onDrop = options.onDrop;
  }

  enqueue(item: T): EnqueueResult {
    if (this.shutdownCalled) {
      this.dropped++;
      this.onDrop?.(item, 'shutdown');
      return { accepted: false, reason: 'shutdown' };
    }

    if (this.queue.length >= this.maxSize) {
      this.dropped++;
      this.onDrop?.(item, 'capacity');
      return { accepted: false, reason: 'capacity' };
    }

    this.queue.push({ item, enqueuedAt: Date.now() });
    this.scheduleProcessing();
    return { accepted: true };
  }

  metrics(): BoundedAsyncQueueMetrics {
    const oldest = this.queue[0];
    return {
      queued: this.queue.length,
      inFlight: this.inFlight,
      processed: this.processed,
      failed: this.failed,
      dropped: this.dropped,
      oldestQueuedAgeMs: oldest ? Date.now() - oldest.enqueuedAt : 0,
    };
  }

  get queueName(): string {
    return this.name;
  }

  /**
   * Wait until the queue is empty and all in-flight work is done.
   * Resolves when queued === 0 && inFlight === 0, or after timeoutMs.
   */
  async flush(timeoutMs?: number): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0) return;

    return new Promise<void>((resolve) => {
      const resolver = (): void => resolve();
      this.flushResolvers.push(resolver);

      if (timeoutMs !== undefined) {
        const t = setTimeout(() => {
          const idx = this.flushResolvers.indexOf(resolver);
          if (idx !== -1) this.flushResolvers.splice(idx, 1);
          resolve();
        }, timeoutMs);
        if (typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
      }
    });
  }

  /**
   * Stop accepting new items.
   * If drain=true, waits for the current queue to finish processing.
   * If drain=false, drops all queued items immediately.
   */
  async shutdown(options: { drain: boolean } = { drain: true }): Promise<void> {
    this.shutdownCalled = true;

    if (!options.drain) {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (entry) {
          this.dropped++;
          this.onDrop?.(entry.item, 'shutdown');
        }
      }
      return;
    }

    await this.flush();
  }

  private scheduleProcessing(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) break;
      this.inFlight++;
      void this.runItem(entry.item);
    }
  }

  private async runItem(item: T): Promise<void> {
    try {
      await this.processItem(item);
      this.processed++;
    } catch {
      this.failed++;
    } finally {
      this.inFlight--;
      this.scheduleProcessing();
      this.checkFlushResolvers();
    }
  }

  private checkFlushResolvers(): void {
    if (this.queue.length === 0 && this.inFlight === 0 && this.flushResolvers.length > 0) {
      const resolvers = this.flushResolvers.splice(0);
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }
}
