import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { globalPauseHoldsAutomaticInput } from '../global-pause/global-pause-service';
import { getLogger } from '../logging/logger';
import { errorDiagnostic } from '../logging/source-diagnostics';
import { ACTIVE_CHILD_TURN_STATUSES } from './instance-communication.constants';

const logger = getLogger('InstanceQueuedInputHandoff');

/** Bounds the gap between provider completion and renderer-owned queue dispatch. */
export class InstanceQueuedInputHandoff {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private settling = new Set<string>();

  retainBusy(
    instance: Instance,
    status: InstanceStatus,
    getReadyId: ((id: string) => string | undefined) | undefined,
    isStale: () => boolean,
    publish: (payload: { instanceId: string; queuedInputReadyId: string; adapterGeneration?: number }) => void,
    settle: () => void,
  ): boolean {
    // Renderer controls still own pause, parking and the actual send. Only a
    // fresh passive durable queue head is eligible for an explicit handoff.
    if (this.settling.has(instance.id) || !getReadyId || instance.provider !== 'codex' || status !== 'idle'
      || !ACTIVE_CHILD_TURN_STATUSES.has(instance.status) || instance.waitReason
      || getPauseCoordinator().isPaused() || globalPauseHoldsAutomaticInput(instance.id)) return false;
    let admissionId: string | undefined;
    try {
      admissionId = getReadyId?.(instance.id);
    } catch (error) {
      logger.warn('Could not prepare queued input handoff', { instanceId: instance.id, ...errorDiagnostic(error) });
    }
    if (!admissionId) return false;
    this.offer(instance.id, () => {
      publish({ instanceId: instance.id, queuedInputReadyId: admissionId, adapterGeneration: instance.adapterGeneration });
    }, () => {
      if (!isStale() && ACTIVE_CHILD_TURN_STATUSES.has(instance.status)) settle();
    });
    return true;
  }

  offer(instanceId: string, publish: () => void, expire: () => void): void {
    if (this.pending.has(instanceId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(instanceId);
      this.settling.add(instanceId);
      try {
        expire();
      } finally {
        this.settling.delete(instanceId);
      }
    }, 30_000);
    timer.unref?.();
    this.pending.set(instanceId, timer);
    publish();
  }

  clear(instanceId: string): void {
    const timer = this.pending.get(instanceId);
    if (timer) clearTimeout(timer);
    this.pending.delete(instanceId);
  }
}

/** Stateless adapters may report busy directly from idle; preserve lifecycle rules. */
export function transitionQueuedAdapterStatus(
  instanceId: string,
  instance: Instance,
  status: InstanceStatus,
  transition: (instance: Instance, status: InstanceStatus) => void,
): InstanceStatus {
  if (instance.status === 'idle' && status === 'busy') {
    logger.debug('Normalizing adapter status transition via ready', { instanceId, from: instance.status, to: status });
    transition(instance, 'ready');
  }
  const previous = instance.status;
  transition(instance, status);
  return previous;
}
