/**
 * Queued messages held by Harness's restart pause.
 *
 * While a pause for restart records a session, every drain skips it
 * (`holdsAutomaticInput`), so its queue waits for James to press Resume. The
 * session sits idle after writing its note, and a queue that silently stops
 * sending looks broken — so the composer says why and offers Send now, which
 * takes the session out of the pause as typing a new message does. Unlike typing, it
 * does not restart a stopped session: Resume reopens that one with its queue.
 *
 * Lives outside `instance-messaging.store.ts`, which is against its LOC ratchet.
 */

import type { IpcFacadeService } from '../../services/ipc';
import type { GlobalPauseStore } from '../global-pause/global-pause.store';
import type { InstanceStateService } from './instance-state.service';
import type { InstanceMessagingStore } from './instance-messaging.store';
import type { QueuePark } from './instance-queue-park';
import { isTerminalStatus } from './instance-messaging-queue-utils';
import { presentError } from '../../../../../shared/present-error';

export interface QueueRestartHold {
  /** True while the restart pause is holding at least one queued message for this session. */
  isHeld: (instanceId: string) => boolean;
  /** Take the session out of the pause, then send its queue. */
  sendNow: (instanceId: string) => Promise<void>;
}

export function createQueueRestartHold(
  state: InstanceStateService,
  globalPause: GlobalPauseStore,
  park: QueuePark,
  ipc: Pick<IpcFacadeService, 'wakeInstance'>,
  messaging: Pick<InstanceMessagingStore, 'getQueuedMessageCount' | 'processMessageQueue'>,
  reportError: (instanceId: string, content: string, detail?: string) => void,
): QueueRestartHold {
  const inFlight = new Set<string>();

  const release = async (instanceId: string): Promise<void> => {
    // A stopped session cannot take the queue, and once out of the pause the watchdog
    // would clear it. Resume reopens the session and carries the queue across.
    if (isTerminalStatus(state.getInstance(instanceId)?.status)) {
      reportError(instanceId, 'This session has stopped, so Send now cannot reach it. Press Resume to reopen it, and your queued message sends after that.');
      return;
    }
    if (!await globalPause.pickUp(instanceId)) {
      reportError(instanceId, 'Could not take this session out of the restart pause. Try Send now again.',
        globalPause.error() ?? undefined);
      return;
    }
    // Send now is an explicit request to send. A hold left by Stop would otherwise
    // swallow it: the session leaves the pause, and nothing is sent.
    park.unpark(instanceId);
    // Drains never touch a sleeping session; wake it, and the drain on ready sends the queue.
    if (state.getInstance(instanceId)?.status === 'hibernated') {
      const woken = await ipc.wakeInstance(instanceId);
      if (!woken.success) {
        // It has already left the pause, so Send now is gone; any new message also wakes it.
        reportError(instanceId, 'Could not wake this session to send your queued message. Send any message to wake it.',
          presentError(woken.error).rawDetail || undefined);
      }
      return;
    }
    messaging.processMessageQueue(instanceId);
  };

  return {
    // Read the recorded sessions, not `holdsAutomaticInput`: that also answers true when the
    // pause state cannot be read, and the card must not describe a pause that is not running.
    isHeld: (instanceId) =>
      messaging.getQueuedMessageCount(instanceId) > 0 && globalPause.state().heldInstanceIds.includes(instanceId),
    sendNow: async (instanceId) => {
      if (inFlight.has(instanceId)) return;
      inFlight.add(instanceId);
      try {
        await release(instanceId);
      } finally {
        inFlight.delete(instanceId);
      }
    },
  };
}
