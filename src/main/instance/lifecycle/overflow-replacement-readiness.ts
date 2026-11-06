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
