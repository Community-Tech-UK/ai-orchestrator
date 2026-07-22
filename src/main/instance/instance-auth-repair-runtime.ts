import type { Instance } from '../../shared/types/instance.types';
import type { CommunicationDependencies } from './instance-communication.types';
import { getInstanceAuthRepairHandler } from './instance-auth-repair-handler';
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceAuthRepairRuntime');

/**
 * Builds the auth-failure callback for InstanceManager. Fire-and-forget by
 * contract: the confirming auth probe is async, and the caller is mid-way
 * through surfacing the turn's error — it must not wait on a CLI probe.
 */
export function createAuthRepairCommunicationCallbacks(
  getInstance: (instanceId: string) => Instance | undefined,
): Pick<CommunicationDependencies, 'onAuthFailureTurn'> {
  return {
    onAuthFailureTurn: (params) => {
      const instance = getInstance(params.instanceId);
      if (!instance) return;
      void getInstanceAuthRepairHandler()
        .maybeBlockOnAuth({
          instanceId: params.instanceId,
          provider: instance.provider,
          reason: params.reason,
          resumePrompt: params.resumePrompt,
        })
        .catch((error) => {
          logger.warn('Auth-failure block attempt failed', {
            instanceId: params.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  };
}
