/**
 * Teardown for adapters a loop owns. terminate() before the child has spawned is a no-op, so a
 * teardown must never be remembered as "done": a later call has to run again.
 */
export function createTrackedAdapterTerminator(
  terminate: (adapter: unknown, graceful: boolean) => Promise<void>,
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
      ? existing.promise.catch(() => undefined).then(() => terminate(adapter, graceful))
      : terminate(adapter, graceful);
    const entry = {
      graceful,
      promise: run.finally(() => { if (inFlight.get(adapter) === entry) inFlight.delete(adapter); }),
    };
    inFlight.set(adapter, entry);
    return entry.promise;
  };
}
