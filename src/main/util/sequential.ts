/**
 * Sequential execution utilities — prevent concurrent async mutations.
 *
 * - sequential()      — wraps any async fn for strict FIFO execution
 * - keyedSequential() — per-key queues (e.g., per-instance operations)
 * - createMutex()     — lightweight acquire/release for code regions
 */

/**
 * Wrap an async function so concurrent calls execute strictly in order.
 * Return values and errors are preserved and forwarded to each caller.
 *
 * @example
 * const safeSave = sequential(save);
 * await Promise.all([safeSave(a), safeSave(b)]); // b waits for a
 */
export function sequential<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  let chain: Promise<unknown> = Promise.resolve();

  return (...args: TArgs): Promise<TReturn> => {
    const next = chain.then(() => fn(...args));
    // Keep the chain going even if fn throws
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    chain = next.catch(() => {});
    return next;
  };
}

/**
 * Per-key sequential execution. The first argument is the key;
 * calls with the same key serialize, different keys run concurrently.
 *
 * @example
 * const safeUpdate = keyedSequential(updateInstance);
 * await Promise.all([safeUpdate('inst-1', data1), safeUpdate('inst-2', data2)]);
 */
export function keyedSequential<TArgs extends [string, ...unknown[]], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: { idleCleanupMs?: number },
): (...args: TArgs) => Promise<TReturn> {
  const chains = new Map<string, Promise<unknown>>();
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const idleMs = options?.idleCleanupMs ?? 60_000;

  return (...args: TArgs): Promise<TReturn> => {
    const key = args[0];
    const prev = chains.get(key) ?? Promise.resolve();

    // Clear any pending cleanup for this key
    const existingTimer = cleanupTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      cleanupTimers.delete(key);
    }

    const next = prev.then(() => fn(...args));
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    chains.set(key, next.catch(() => {}));

    // Schedule cleanup after chain goes idle
    const scheduleCleanup = (): void => {
      const timer = setTimeout(() => {
        cleanupTimers.delete(key);
        chains.delete(key);
      }, idleMs);
      if (timer.unref) timer.unref();
      cleanupTimers.set(key, timer);
    };

    void next.finally(scheduleCleanup);

    return next;
  };
}

/**
 * Lightweight mutex for protecting code regions.
 *
 * @example
 * const mutex = createMutex();
 * const release = await mutex.acquire();
 * try { ... } finally { release(); }
 */
export function createMutex(): { acquire: () => Promise<() => void>; isLocked: () => boolean } {
  let chain: Promise<unknown> = Promise.resolve();
  let locked = false;

  return {
    acquire(): Promise<() => void> {
      let releaseFn!: () => void;
      const next = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });

      const acquisition = chain.then(() => {
        locked = true;
      });

      chain = next;

      return acquisition.then(() => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          locked = false;
          releaseFn();
        };
      });
    },

    isLocked(): boolean {
      return locked;
    },
  };
}
