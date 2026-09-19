/**
 * Sleeps for `ms` milliseconds, or resolves immediately once `signal` aborts
 * — whichever comes first. Used by long-polling RPC tool handlers (e.g.
 * `read_node_output`'s `waitMs`) so a caller disconnecting mid-wait releases
 * the poll instead of running out its full remaining interval for nobody.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  const uniqueSignals = Array.from(new Set(signals));
  if (uniqueSignals.length === 0) {
    return new AbortController().signal;
  }
  if (uniqueSignals.length === 1) {
    return uniqueSignals[0]!;
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();

  const cleanup = (): void => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
    listeners.clear();
  };

  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
    cleanup();
  };

  for (const signal of uniqueSignals) {
    if (controller.signal.aborted) break;
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = (): void => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) {
      abortFrom(signal);
    }
  }

  return controller.signal;
}
