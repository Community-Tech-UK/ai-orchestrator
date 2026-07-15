import type { Instance } from '../../shared/types/instance.types';
import type { CommunicationDependencies } from './instance-communication.types';
import { getInstanceProviderLimitHandler } from './instance-provider-limit-handler';

/** Builds the regular-session provider-limit callbacks for InstanceManager. */
export function createProviderLimitCommunicationCallbacks(
  getInstance: (instanceId: string) => Instance | undefined,
): Pick<CommunicationDependencies, 'onProviderLimitTurn' | 'checkKnownProviderLimitBeforeSend'> {
  return {
    onProviderLimitTurn: (params) => {
      const instance = getInstance(params.instanceId);
      if (!instance) return 'skipped';
      return getInstanceProviderLimitHandler().maybePark({
        instanceId: params.instanceId,
        provider: instance.provider,
        model: instance.currentModel ?? null,
        resetAtHint: params.resetAtHint,
        reason: params.reason,
        resumePrompt: params.resumePrompt,
      });
    },
    checkKnownProviderLimitBeforeSend: (params) =>
      getInstanceProviderLimitHandler().maybeParkKnown({
        instanceId: params.instanceId,
        provider: params.provider,
        model: params.model,
        reason: 'Known active provider limit; holding the turn until the provider reset time',
        resumePrompt: params.prompt,
      }),
  };
}
