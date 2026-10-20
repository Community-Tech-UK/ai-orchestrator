import type { Instance } from '../../shared/types/instance.types';
import type { CommunicationDependencies } from './instance-communication.types';
import { getInstanceProviderLimitHandler } from './instance-provider-limit-handler';
import { currentAccountProfileId } from '../providers/account-pool/account-failover-coordinator';
import { detectErrorProviderLimit, readAdapterRateLimitTelemetry } from './instance-provider-limit-detection';
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceProviderLimitRuntime');

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
        quotaBlind: params.quotaBlind,
        reason: params.reason,
        resumePrompt: params.resumePrompt,
        accountProfileId: currentAccountProfileId(instance),
      });
    },
    checkKnownProviderLimitBeforeSend: (params) => {
      const instance = getInstance(params.instanceId);
      return getInstanceProviderLimitHandler().maybeParkKnown({
        instanceId: params.instanceId,
        provider: params.provider,
        model: params.model,
        reason: 'Known active provider limit; holding the turn until the provider reset time',
        resumePrompt: params.prompt,
        accountProfileId: instance ? currentAccountProfileId(instance) : null,
      });
    },
  };
}

/**
 * An orchestration response that was not delivered: when the provider refused
 * it on a usage limit, hand that to the park/account-switch funnel with nothing
 * to re-send (the response itself waits in admission), exactly as a refused
 * user turn would be. When the funnel declines to park (automatic resume is
 * off) the limit it just recorded still holds the response, hold-only. Any
 * other failure waits too while the session is parked or its account has a
 * known limit. False otherwise, including when the check itself throws; the
 * response then fails as before, with its transcript note.
 */
export function holdRejectedOrchestrationResponse(
  instance: Instance | undefined,
  adapter: unknown,
  error: Error,
): boolean {
  if (!instance) return false;
  try {
    return holdRejected(instance, adapter, error);
  } catch (checkError) {
    logger.warn('Could not check an undelivered orchestration response against provider limits; failing it', {
      instanceId: instance.id,
      error: checkError instanceof Error ? checkError.message : String(checkError),
    });
    return false;
  }
}

function holdRejected(instance: Instance, adapter: unknown, error: Error): boolean {
  const signal = detectErrorProviderLimit(error, error.message, readAdapterRateLimitTelemetry(adapter), instance.provider);
  const handler = getInstanceProviderLimitHandler();
  if (!signal) return handler.holdAutomatedTurn(instance.id);
  const outcome = handler.maybePark({
    instanceId: instance.id,
    provider: instance.provider,
    model: instance.currentModel ?? null,
    resetAtHint: signal.resetAtHint,
    quotaBlind: signal.quotaBlind,
    reason: signal.reason,
    resumePrompt: null,
    accountProfileId: currentAccountProfileId(instance),
  });
  return outcome !== 'skipped' || handler.holdAutomatedTurn(instance.id);
}

/**
 * Pre-send hold for a queued orchestration response. Fails open, like the
 * admission check: an unreadable limit state must not fail a response that
 * may well be deliverable.
 */
export function holdQueuedOrchestrationResponse(instanceId: string): boolean {
  try {
    return getInstanceProviderLimitHandler().holdAutomatedTurn(instanceId);
  } catch (checkError) {
    logger.warn('Could not check a queued orchestration response against provider limits; sending it', {
      instanceId,
      error: checkError instanceof Error ? checkError.message : String(checkError),
    });
    return false;
  }
}
