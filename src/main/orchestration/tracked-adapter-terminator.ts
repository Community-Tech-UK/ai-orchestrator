import { getLogger } from '../logging/logger';

const logger = getLogger('TrackedAdapterTerminator');

/**
 * Teardown for adapters a loop owns. terminate() before the child has spawned is a no-op, so a
 * teardown must never be remembered as "done": a later call has to run again.
 */
export function createTrackedAdapterTerminator(
  terminate: (adapter: unknown, graceful: boolean) => Promise<void>,
  /** Longest an `afterInFlight` pass waits for a teardown already in flight before running anyway. */
  inFlightWaitMs = 5000,
): (adapter: unknown, graceful: boolean, afterInFlight?: boolean) => Promise<void> {
  const inFlight = new WeakMap<object, { graceful: boolean; promise: Promise<void> }>();
  // Concurrent callers share one teardown, except that a forced call is never absorbed by a graceful one.
  // `afterInFlight` (an invocation's own cleanup) runs a fresh pass once any teardown in flight settles,
  // because that one may have passed its process check before the child spawned.
  return (adapter, graceful, afterInFlight = false) => {
    if (!adapter || typeof adapter !== 'object') return terminate(adapter, graceful);
    const existing = inFlight.get(adapter);
    if (existing && !afterInFlight && (graceful || !existing.graceful)) return existing.promise;
    const run = existing && afterInFlight
      ? waitUpTo(existing.promise, inFlightWaitMs).then(() => terminate(adapter, graceful))
      : terminate(adapter, graceful);
    const entry = {
      graceful,
      promise: run.finally(() => { if (inFlight.get(adapter) === entry) inFlight.delete(adapter); }),
    };
    inFlight.set(adapter, entry);
    return entry.promise;
  };
}

function waitUpTo(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Stops a loop-owned child the moment it exists when its loop has already ended. Real adapters spawn inside
 * sendMessage and run the whole turn in that same call, so waiting for sendMessage to return leaves the child
 * running (and editing the workspace) until the turn ends. BaseCliAdapter.spawnProcess emits `spawned` for every
 * real child; the Codex app-server adapter emits it once its server is up. Returns the unsubscribe function.
 */
export function stopAdapterAtSpawn(
  adapter: unknown,
  mustStop: () => boolean,
  stop: () => Promise<void>,
): () => void {
  const emitter = adapter as { on?: (event: string, listener: () => void) => void; off?: (event: string, listener: () => void) => void };
  if (typeof emitter.on !== 'function') return () => undefined;
  // The event fires inside spawnProcess, before the adapter stores the child; stop on the next microtask.
  const onSpawned = (): void => {
    if (mustStop()) queueMicrotask(() => { stop().catch((error: unknown) => logger.warn('Stopping a child spawned after its loop ended failed', { error: String(error) })); });
  };
  emitter.on('spawned', onSpawned);
  return () => emitter.off?.('spawned', onSpawned);
}

/**
 * A child stopped because its loop ended makes sendMessage reject, which would count against the provider's shared
 * circuit breaker. Pass `signal` to `breaker.execute` (an aborted call records neither success nor failure) and
 * route the call's rejection through `translate`.
 */
export function createLoopStopSignal(): { signal: AbortSignal; translate: (error: unknown, stopped: boolean) => unknown } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    translate: (error, stopped) => {
      if (!stopped) return error;
      controller.abort();
      return new Error('instance-interrupted');
    },
  };
}

/** A reused adapter is let go once a recycle replaced it; a missing entry alone (never registered) is not. */
export function shouldReapPersistent(held: unknown, adapter: unknown): boolean {
  return held !== undefined && held !== adapter;
}
