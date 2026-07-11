export type PromiseSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export function settlePromise<T>(factory: () => Promise<T>): Promise<PromiseSettlement<T>> {
  return Promise.resolve()
    .then(factory)
    .then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
}

/** Wait for a handled settlement, but let caller cancellation wake the waiter. */
export async function waitForSettlementOrAbort<T>(
  settlement: Promise<PromiseSettlement<T>>,
  signal: AbortSignal,
): Promise<PromiseSettlement<T> | { status: 'aborted' }> {
  if (signal.aborted) return { status: 'aborted' };
  let onAbort!: () => void;
  const aborted = new Promise<{ status: 'aborted' }>((resolve) => {
    onAbort = () => resolve({ status: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([settlement, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
