import type { InstanceBackgroundWork } from '../../shared/types/instance.types';
import { registerCleanup } from '../util/cleanup-registry';
import {
  getInstanceAsyncWorkRegistry,
  type InstanceAsyncWorkChangedEvent,
  type InstanceAsyncWorkRegistry,
} from './instance-async-work-registry';

export interface InstanceAsyncWorkPublisherHost {
  queueInstanceUpdate(instanceId: string, update: { backgroundWork: InstanceBackgroundWork | null }): void;
}

/**
 * Mirrors the registry's live background work onto the instance and the
 * renderer state stream, so an idle session that is still waiting on a
 * background task is visibly different from one that has finished.
 */
export function bindInstanceAsyncWorkPublisher(
  registry: InstanceAsyncWorkRegistry,
  host: InstanceAsyncWorkPublisherHost,
): () => void {
  const onChanged = ({ instanceId, summary }: InstanceAsyncWorkChangedEvent): void => {
    host.queueInstanceUpdate(instanceId, { backgroundWork: summary });
  };
  registry.on('work:changed', onChanged);
  return () => registry.off('work:changed', onChanged);
}

let unbind: (() => void) | null = null;

export function initializeInstanceAsyncWorkPublisher(host: InstanceAsyncWorkPublisherHost): void {
  unbind?.();
  unbind = bindInstanceAsyncWorkPublisher(getInstanceAsyncWorkRegistry(), host);
  registerCleanup(() => {
    unbind?.();
    unbind = null;
  });
}
