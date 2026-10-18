import type { CliResponse } from './base-cli-adapter.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('DeferredResponseUsage');

// Cost settlement is an in-process concern. Never attach promises or callbacks
// to a response that can be serialized by provider/worker event forwarding.
const pending = new WeakMap<CliResponse, (() => void)[]>();

export function deferResponseUsage(response: CliResponse): () => void {
  const callbacks: (() => void)[] = [];
  pending.set(response, callbacks);
  return () => {
    if (pending.get(response) !== callbacks) return;
    pending.delete(response);
    for (const callback of callbacks) {
      try { callback(); } catch (error) {
        logger.warn('Deferred usage observer failed', { error: String(error) });
      }
    }
  };
}

/** Returns true only when the callback was queued for a later usage settlement. */
export function deferUntilResponseUsageSettled(response: CliResponse, callback: () => void): boolean {
  const callbacks = pending.get(response);
  if (!callbacks) return false;
  callbacks.push(callback);
  return true;
}
