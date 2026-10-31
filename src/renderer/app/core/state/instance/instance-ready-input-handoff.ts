import type { InstanceStateService } from './instance-state.service';
import type { PauseStore } from '../pause/pause.store';
import type { GlobalPauseStore } from '../global-pause/global-pause.store';
import type { QueuePersistenceService } from './queue-persistence.service';
import type { InstanceMessagingStore } from './instance-messaging.store';
import type { createQueuePark } from './instance-queue-park';
import { isActiveTurnStatus, isQuotaParked, pickQueuedMetadata, removeQueuedEntry } from './instance-messaging-queue-utils';

/** Main retained busy while releasing the previous provider turn for this admission. */
export function createReadyInputHandoff(
  state: InstanceStateService,
  pause: PauseStore,
  globalPause: GlobalPauseStore,
  park: ReturnType<typeof createQueuePark>,
  persistence: QueuePersistenceService,
  sender: Pick<InstanceMessagingStore, 'sendInputImmediate'>,
): (instanceId: string, admissionId: string, adapterGeneration?: number) => Promise<void> {
  const inFlight = new Set<string>();
  return async (instanceId, admissionId, adapterGeneration) => {
    const canDrain = (): boolean => {
      const instance = state.getInstance(instanceId);
      return Boolean(instance && isActiveTurnStatus(instance.status)
        && (adapterGeneration === undefined || instance.adapterGeneration === adapterGeneration)
        && !pause.isPaused() && !globalPause.holdsAutomaticInput(instanceId)
        && !isQuotaParked(instance) && !park.isParked(instanceId));
    };
    if (!canDrain() || inFlight.has(instanceId)) return;
    inFlight.add(instanceId);
    try {
      const next = await persistence.promoteReadyHandoff(instanceId, admissionId);
      if (!next || !canDrain()) return;
      if (next.retryAfterAt !== undefined && next.retryAfterAt > Date.now()) return;
      if (!removeQueuedEntry(state, instanceId, next)) return;
      await sender.sendInputImmediate(instanceId, next.message, next.files, next.retryCount ?? 0, {
        queuedEntry: next,
        skipUserBubble: next.seededAlready === true,
        queuedMetadata: pickQueuedMetadata(next),
        retryAfterAt: next.retryAfterAt,
      }, true);
    } finally {
      inFlight.delete(instanceId);
    }
  };
}
