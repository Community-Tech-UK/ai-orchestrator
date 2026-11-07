import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { throwIfInstanceInputAborted, type InstanceSendInputOptions } from './instance-input-cancellation';

const logger = getLogger('InstanceInputReady');

// Statuses in which delivering user input can never succeed; a send fails
// fast when the instance lands in one of these while waiting on init/respawn.
const SEND_TERMINAL_STATUSES = new Set<InstanceStatus>(['terminated', 'failed', 'error', 'cancelled', 'superseded']);

export interface InputReadyHost {
  wake(instanceId: string): Promise<void>;
  /** Waits for `work`, giving up after the instance's init budget (scaled by host load and replay size). */
  waitWithBudget(work: Promise<void>, instance: Instance, timeoutMessage: string): Promise<void>;
  getInstance(instanceId: string): Instance | undefined;
}

/** Waits until a session can take input: wakes a hibernated one and lets init or a respawn finish. */
export async function awaitInstanceInputReady(
  host: InputReadyHost,
  instance: Instance,
  options?: InstanceSendInputOptions,
): Promise<void> {
  const instanceId = instance.id;
  // A hibernated session has no adapter: the memory governor killed the CLI
  // to free heap and left the transcript in place, telling the user to send a
  // message to wake it. Honour that here — otherwise the send falls through
  // to the communication layer's "no adapter" bug-state branch, which cannot
  // even mark the instance failed (hibernated -> error is an illegal
  // transition) and leaves the renderer's message queued against a session
  // that will never become idle. Discord/doc-review deliveries already wake
  // first; this is the same contract for the app's own send path.
  if (instance.status === 'hibernated' || instance.status === 'waking') {
    logger.info('Send targets a hibernated session — waking before delivery', {
      instanceId,
      status: instance.status,
    });
    await host.waitWithBudget(
      host.wake(instanceId),
      instance,
      'Instance wake timed out',
    );
    throwIfInstanceInputAborted(options?.signal);
    // Cast via string to bypass TS narrowing (status was mutated by the wake).
    const postWakeStatus = instance.status as string;
    if (postWakeStatus === 'failed' || postWakeStatus === 'error') {
      throw new Error(`Instance ${instanceId} failed to wake from hibernation`);
    }
  }

  // Wait for a background init to finish before delivering input. The budget
  // scales with host load and transcript-replay size (see init-wait-budget).
  // On timeout we do NOT abort: a large-context replay may still be
  // progressing, so re-throw and let the renderer re-queue against the same
  // readyPromise (dead inits are caught by wake deadlines + StuckProcessDetector).
  if (instance.readyPromise) {
    await host.waitWithBudget(
      instance.readyPromise,
      instance,
      'Instance initialization timed out',
    );
    throwIfInstanceInputAborted(options?.signal);
    if (instance.status === 'failed') {
      throw new Error('Instance initialization failed');
    }
  }

  // If the instance is respawning after an interrupt, wait for it to finish.
  // This holds the IPC call instead of rejecting, so the renderer's queued
  // message is delivered once the new CLI process is ready.
  if (instance.respawnPromise) {
    await host.waitWithBudget(
      instance.respawnPromise,
      instance,
      'Instance respawn timed out',
    );
    throwIfInstanceInputAborted(options?.signal);
    if (instance.status === 'error' || instance.status === 'failed') {
      throw new Error('Instance respawn after interrupt failed');
    }
  }

  // The waits above can outlive the instance: a wedged init/respawn may only
  // settle when the user terminates the session, after which the input would
  // travel the rest of the pipeline and vanish in the communication layer
  // ("Instance not found in state") with no renderer left listening.
  // Re-validate liveness so the renderer instead gets an immediate terminal
  // failure it maps to no-retry + restore-to-draft.
  const liveInstance = host.getInstance(instanceId);
  if (!liveInstance || SEND_TERMINAL_STATUSES.has(liveInstance.status)) {
    throw new Error(
      `Instance ${instanceId} terminated while waiting to deliver input`
      + ` (status: ${liveInstance?.status ?? 'removed'})`,
    );
  }
}
