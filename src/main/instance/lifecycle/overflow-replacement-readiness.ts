import type { Instance } from '../../../shared/types/instance.types';

/** Holds newer input until an overflow-owned destructive replacement finishes. */
export function beginOverflowReplacementReadiness(
  instance: Instance,
  transition: (instance: Instance, status: 'initializing' | 'error') => void,
): { fail(): void; close(): void } {
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  instance.readyPromise = ready;
  try { transition(instance, 'initializing'); } catch (error) {
    if (instance.readyPromise === ready) instance.readyPromise = undefined;
    resolve();
    throw error;
  }
  return {
    fail: () => {
      if (instance.readyPromise === ready && instance.status === 'initializing') transition(instance, 'error');
    },
    close: () => {
      if (instance.readyPromise === ready) instance.readyPromise = undefined;
      resolve();
    },
  };
}

/**
 * Holds input while an in-place restart rebuilds the adapter. The restart sets its own statuses, so this only makes
 * `awaitInstanceInputReady` wait: a send that arrives mid-restart used to find no adapter, be refused as an inconsistent
 * state and mark the session `error` under the restart. An init or wake already holding input keeps that hold.
 * Returns the function that releases the hold.
 */
export function holdInputWhileRestarting(instance: Instance): () => void {
  if (instance.readyPromise) return () => undefined;
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  instance.readyPromise = ready;
  return () => {
    if (instance.readyPromise === ready) instance.readyPromise = undefined;
    resolve();
  };
}
