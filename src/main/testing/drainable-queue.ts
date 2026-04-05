/**
 * DrainableQueue — Deterministic async work coordination for tests
 *
 * Wraps an async processor with a queue that tracks outstanding work.
 * `drain()` resolves only when ALL enqueued items have finished processing,
 * eliminating flaky `setTimeout`/`sleep` patterns in async coordination tests.
 *
 * Inspired by T3Code's DrainableWorker (Effect-based) — adapted for
 * plain TypeScript / Vitest without Effect dependency.
 *
 * Usage in tests:
 * ```typescript
 *   const queue = new DrainableQueue<AgentResponse>(async (response) => {
 *     coordinator.handleAgentResponse(response);
 *   });
 *
 *   queue.enqueue({ agentId: 'a1', answer: 'yes', confidence: 0.9 });
 *   queue.enqueue({ agentId: 'a2', answer: 'yes', confidence: 0.85 });
 *   await queue.drain();
 *
 *   expect(coordinator.getConsensus()).toBeDefined();
 * ```
 *
 * Can also be used in production code for batched I/O:
 * ```typescript
 *   const writer = new DrainableQueue<OutputChunk>(async (chunk) => {
 *     await db.write(chunk);
 *   }, { concurrency: 1 });
 *
 *   // On shutdown:
 *   await writer.drain();
 * ```
 */

export interface DrainableQueueOptions {
  /**
   * Maximum number of items processed concurrently.
   * Default: Infinity (all items start immediately).
   * Set to 1 for sequential processing.
   */
  concurrency?: number;
}

export class DrainableQueue<T> {
  private readonly processor: (item: T) => Promise<void>;
  private readonly concurrency: number;

  /** Items waiting to be picked up by a processing slot. */
  private pending: T[] = [];
  /** Number of items currently inside the processor function. */
  private active = 0;
  /** Callbacks waiting for all work to finish. */
  private drainCallbacks: (() => void)[] = [];
  /** Total items enqueued (for diagnostics). */
  private totalEnqueued = 0;
  /** Total items completed (for diagnostics). */
  private totalCompleted = 0;
  /** Total items that threw errors. */
  private totalErrored = 0;
  /** Errors captured during processing (surfaced by drain()). */
  private errors: { item: T; error: unknown }[] = [];

  constructor(
    processor: (item: T) => Promise<void>,
    options?: DrainableQueueOptions,
  ) {
    this.processor = processor;
    this.concurrency = options?.concurrency ?? Infinity;
  }

  /**
   * Add an item to the queue. Processing starts immediately if a
   * concurrency slot is available; otherwise it waits in FIFO order.
   */
  enqueue(item: T): void {
    this.totalEnqueued++;
    this.pending.push(item);
    this.flush();
  }

  /**
   * Add multiple items at once. Equivalent to calling enqueue() for each.
   */
  enqueueAll(items: readonly T[]): void {
    for (const item of items) {
      this.enqueue(item);
    }
  }

  /**
   * Returns a promise that resolves when:
   * 1. The pending queue is empty, AND
   * 2. All active processors have completed.
   *
   * If any processor threw an error, drain() rejects with an
   * AggregateError containing all captured errors.
   *
   * Safe to call multiple times — each call gets its own promise.
   * If no work is outstanding, resolves immediately.
   */
  drain(): Promise<void> {
    if (this.isIdle()) {
      return this.resolveDrain();
    }
    return new Promise<void>((resolve, reject) => {
      this.drainCallbacks.push(() => {
        if (this.errors.length > 0) {
          const errs = this.errors.splice(0);
          reject(
            new AggregateError(
              errs.map((e) => e.error),
              `DrainableQueue: ${errs.length} processor error(s)`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Like drain(), but discards any accumulated errors instead of throwing.
   * Useful in afterEach() cleanup where you want to ensure the queue is
   * flushed but don't care about errors from the test.
   */
  async drainSilent(): Promise<void> {
    if (this.isIdle()) {
      this.errors.length = 0;
      return;
    }
    return new Promise<void>((resolve) => {
      this.drainCallbacks.push(() => {
        this.errors.length = 0;
        resolve();
      });
    });
  }

  /** Number of items waiting to be processed. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Number of items currently being processed. */
  get activeCount(): number {
    return this.active;
  }

  /** True when no items are pending or active. */
  isIdle(): boolean {
    return this.pending.length === 0 && this.active === 0;
  }

  /** Diagnostic stats. */
  stats(): { totalEnqueued: number; totalCompleted: number; totalErrored: number; pending: number; active: number } {
    return {
      totalEnqueued: this.totalEnqueued,
      totalCompleted: this.totalCompleted,
      totalErrored: this.totalErrored,
      pending: this.pending.length,
      active: this.active,
    };
  }

  /**
   * Reset the queue, discarding any pending items. Active items will
   * still complete but their results are ignored. Useful in beforeEach().
   */
  reset(): void {
    this.pending.length = 0;
    this.totalEnqueued = 0;
    this.totalCompleted = 0;
    this.totalErrored = 0;
    this.errors.length = 0;
    // Don't clear drainCallbacks — active work will still complete
    // and should notify waiters.
  }

  // ── Internal ──────────────────────────────────────────────────

  /** Start processing pending items up to the concurrency limit. */
  private flush(): void {
    while (this.pending.length > 0 && this.active < this.concurrency) {
      const item = this.pending.shift()!;
      this.active++;
      this.processItem(item);
    }
  }

  /** Process a single item and update counters when done. */
  private processItem(item: T): void {
    this.processor(item).then(
      () => {
        this.totalCompleted++;
        this.active--;
        this.flush();
        this.checkDrain();
      },
      (error) => {
        this.totalErrored++;
        this.errors.push({ item, error });
        this.active--;
        this.flush();
        this.checkDrain();
      },
    );
  }

  /** If all work is done, notify drain() waiters. */
  private checkDrain(): void {
    if (this.isIdle() && this.drainCallbacks.length > 0) {
      const callbacks = this.drainCallbacks.splice(0);
      for (const cb of callbacks) {
        cb();
      }
    }
  }

  /** Resolve immediately, optionally throwing if errors exist. */
  private resolveDrain(): Promise<void> {
    if (this.errors.length > 0) {
      const errs = this.errors.splice(0);
      return Promise.reject(
        new AggregateError(
          errs.map((e) => e.error),
          `DrainableQueue: ${errs.length} processor error(s)`,
        ),
      );
    }
    return Promise.resolve();
  }
}

// ── KeyedCoalescingQueue ───────────────────────────────────────

/**
 * KeyedCoalescingQueue — Batched writes that merge by key.
 *
 * When the same key is enqueued multiple times before processing starts,
 * only the LATEST value is kept. Reduces write contention from O(n) to O(1)
 * per burst (e.g., instance output arriving in rapid chunks).
 *
 * Inspired by T3Code's KeyedCoalescingWorker.
 *
 * Usage:
 * ```typescript
 *   const writer = new KeyedCoalescingQueue<string, OutputChunk>(
 *     async (instanceId, chunk) => { await db.write(instanceId, chunk); }
 *   );
 *
 *   writer.enqueue('inst-1', chunk1);
 *   writer.enqueue('inst-1', chunk2); // Replaces chunk1
 *   writer.enqueue('inst-2', chunk3);
 *
 *   await writer.drain(); // Processes: ('inst-1', chunk2), ('inst-2', chunk3)
 * ```
 */
export class KeyedCoalescingQueue<K, V> {
  private readonly processor: (key: K, value: V) => Promise<void>;

  /** Latest value per key, waiting to be processed. */
  private latest = new Map<K, V>();
  /** Keys currently being processed. */
  private activeKeys = new Set<K>();
  /** Drain callbacks. */
  private drainCallbacks: (() => void)[] = [];

  constructor(processor: (key: K, value: V) => Promise<void>) {
    this.processor = processor;
  }

  /**
   * Enqueue a value for the given key. If the key is already queued
   * (but not yet processing), the old value is replaced with the new one.
   */
  enqueue(key: K, value: V): void {
    this.latest.set(key, value);
    this.flush();
  }

  /**
   * Resolves when all keys have been processed and no items are pending.
   */
  drain(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainCallbacks.push(resolve);
    });
  }

  /**
   * Resolves when the specific key has finished processing and is no
   * longer in the pending or active set.
   */
  drainKey(key: K): Promise<void> {
    if (!this.latest.has(key) && !this.activeKeys.has(key)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (!this.latest.has(key) && !this.activeKeys.has(key)) {
          resolve();
        } else {
          // Re-check after next processing cycle
          this.drainCallbacks.push(check);
        }
      };
      this.drainCallbacks.push(check);
    });
  }

  isIdle(): boolean {
    return this.latest.size === 0 && this.activeKeys.size === 0;
  }

  // ── Internal ──────────────────────────────────────────────────

  private flush(): void {
    for (const [key, value] of this.latest) {
      if (this.activeKeys.has(key)) {
        continue; // Key already processing — the latest value stays queued
      }
      this.latest.delete(key);
      this.activeKeys.add(key);
      this.processItem(key, value);
    }
  }

  private processItem(key: K, value: V): void {
    this.processor(key, value).then(
      () => {
        this.activeKeys.delete(key);
        // If a new value was enqueued for this key while we were processing,
        // pick it up now.
        this.flush();
        this.checkDrain();
      },
      () => {
        this.activeKeys.delete(key);
        this.flush();
        this.checkDrain();
      },
    );
  }

  private checkDrain(): void {
    if (this.drainCallbacks.length > 0) {
      const callbacks = this.drainCallbacks.splice(0);
      for (const cb of callbacks) {
        cb();
      }
    }
  }
}
