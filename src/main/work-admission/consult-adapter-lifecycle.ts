import { getLogger } from '../logging/logger';
import { trackConsult } from './consult-admission';

const logger = getLogger('ConsultAdapterLifecycle');
const cleanups = new WeakMap<object, () => Promise<void>>();

/** An operation can acknowledge cancellation before its provider has stopped. */
export function trackConsultAdapter(adapter: object, cleanup: () => Promise<void>): () => Promise<void> {
  const existing = cleanups.get(adapter);
  if (existing) return existing;
  let pending: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    if (pending) return pending;
    const attempt = Promise.resolve().then(cleanup);
    pending = attempt;
    void attempt.then(() => { untrack(); cleanups.delete(adapter); }, () => {
      // Keep the reservation and allow the next Pause attempt to retry cleanup.
      if (pending === attempt) pending = undefined;
    });
    return attempt;
  };
  const untrack = trackConsult(() => {
    const interrupt = (adapter as { interrupt?: () => unknown }).interrupt;
    try {
      if (typeof interrupt === 'function') {
        void Promise.resolve(interrupt.call(adapter)).catch(error => logger.warn('Review interrupt failed', { error }));
      }
    } catch (error) { logger.warn('Review interrupt failed', { error }); }
    void finish().catch(error => logger.warn('Review teardown is still pending', { error }));
  });
  cleanups.set(adapter, finish);
  return finish;
}

/** Reuse the authoritative teardown instead of launching a second termination. */
export function stopTrackedConsultAdapter(adapter: unknown): Promise<void> | undefined {
  return adapter !== null && typeof adapter === 'object' ? cleanups.get(adapter)?.() : undefined;
}
