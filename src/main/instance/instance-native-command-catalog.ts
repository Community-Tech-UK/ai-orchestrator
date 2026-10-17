import type { EventEmitter } from 'node:events';
import type { Instance } from '../../shared/types/instance.types';

/** Catalogs are transient session state; reuse the renderer state-update transport. */
export function bindInstanceNativeCommandForwarding(
  communication: Pick<EventEmitter, 'on'>,
  owner: Pick<EventEmitter, 'emit'> & { getInstance(id: string): Instance | undefined },
): void {
  communication.on('commands-changed', ({ instanceId }: { instanceId: string }) => {
    // Pending/unpublished recovery instances are absent from the public lookup.
    const instance = owner.getInstance(instanceId);
    if (instance?.provider !== 'opencode') return;
    owner.emit('instance:state-update', {
      instanceId, status: instance.status, commandsChanged: true,
      restartEpoch: instance.restartEpoch, adapterGeneration: instance.adapterGeneration,
      providerSessionId: instance.providerSessionId,
    });
  });
}
