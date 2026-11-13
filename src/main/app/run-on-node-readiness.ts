import type { EventEmitter } from 'node:events';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceStateChangedEvent } from '../instance/instance-manager';
import type { AutomaticStartup } from '../work-admission/automatic-startup';

const ACTIVE_INPUT_STATUSES = new Set<Instance['status']>(['busy', 'processing', 'thinking_deeply']);

/**
 * A worker's sendInput can stay pending for its entire first turn. Startup owns
 * that promise and its failures; the caller only needs the working session id.
 * Wait for actual dispatched input plus worker activity, never spawn's initial
 * busy status alone. A short or held first turn still settles through readiness.
 */
export async function waitForRunOnNodeReadiness(
  manager: Pick<EventEmitter, 'on' | 'off'>,
  instance: Instance,
  startup: Pick<AutomaticStartup, 'wasDispatched' | 'signal'>,
): Promise<void> {
  const ready = instance.readyPromise;
  if (!ready) return;
  let accept!: () => void;
  let abort!: () => void;
  const dispatched = new Promise<void>((resolve, reject) => {
    accept = () => {
      if (startup.wasDispatched(instance.id) && ACTIVE_INPUT_STATUSES.has(instance.status)) resolve();
    };
    abort = () => reject(startup.signal.reason);
  });
  const changed = (event: InstanceStateChangedEvent): void => {
    if (event.instanceId === instance.id) accept();
  };
  manager.on('instance:state-changed', changed);
  startup.signal.addEventListener('abort', abort, { once: true });
  try {
    if (startup.signal.aborted) abort();
    else accept();
    await Promise.race([ready, dispatched]);
  } finally {
    manager.off('instance:state-changed', changed);
    startup.signal.removeEventListener('abort', abort);
  }
}
