import type { InstanceSendInputOptions } from '../instance/instance-input-cancellation';
import { isAutomaticInstanceInput, throwIfInstanceInputAborted } from '../instance/instance-input-cancellation';
import { GlobalPauseService } from './global-pause-service';
import { getWorkAdmission } from '../work-admission/work-admission';

/** Wait rather than drop automatic deliveries; a typed message takes ownership immediately. */
export async function waitForGlobalPauseInput(instanceId: string, options?: InstanceSendInputOptions): Promise<void> {
  if (options?.autoContinuation) await getWorkAdmission().wait('timed-wakeup', {}, options.signal);
  const pause = GlobalPauseService.peek();
  if (!pause) return;
  if (options?.internalSource === 'global-pause-note' || options?.internalSource === 'global-pause-resume') return;
  const automatic = isAutomaticInstanceInput(options);
  if (!automatic) { pause.manualInput(instanceId); return; }
  if (!pause.holdsAutomaticInput(instanceId)) return;
  throwIfInstanceInputAborted(options?.signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { pause.off('state-changed', changed); options?.signal?.removeEventListener('abort', aborted); };
    const changed = (): void => { if (!pause.holdsAutomaticInput(instanceId)) { cleanup(); resolve(); } };
    const aborted = (): void => { cleanup(); const error = new Error('Automatic input cancelled while paused'); error.name = 'AbortError'; reject(error); };
    pause.on('state-changed', changed); options?.signal?.addEventListener('abort', aborted, { once: true });
    if (options?.signal?.aborted) aborted(); else changed();
  });
}

class AutomaticInputHeldError extends Error {}

/** Synchronous final fence for adapters that await their own provider preparation. */
export function assertGlobalPauseInputCurrent(instanceId: string, options?: InstanceSendInputOptions): void {
  if (options?.internalSource === 'global-pause-note' || options?.internalSource === 'global-pause-resume') return;
  if ((options?.autoContinuation && !getWorkAdmission().check('timed-wakeup').allowed)
    || (isAutomaticInstanceInput(options) && GlobalPauseService.peek()?.holdsAutomaticInput(instanceId))) throw new AutomaticInputHeldError();
}

/** Only retry the fence rejection: no provider write has happened at that point. */
export async function runWithGlobalPauseInput<T>(instanceId: string, options: InstanceSendInputOptions | undefined, work: () => Promise<T>): Promise<T> {
  while (true) {
    await waitForGlobalPauseInput(instanceId, options);
    throwIfInstanceInputAborted(options?.signal);
    try { return await work(); }
    catch (error) { if (!(error instanceof AutomaticInputHeldError)) throw error; }
  }
}
