import type { Instance } from '../../shared/types/instance.types';
import type { ProviderId } from '../../shared/types/provider-quota.types';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { getCopilotCreditRecorder } from '../core/system/copilot-credit-recorder';
import { resolveBillingMode } from '../../shared/utils/billing-mode';
import { resolveCacheTtlMs } from '../../shared/utils/cache-ttl';
import { getCacheAnalyticsService } from './cache-analytics-service';

export function instanceCacheTtlMs(instance: Instance): number | undefined {
  const profile = instance.provider === 'copilot' ? instance.copilotAccountProfileId : instance.accountProfileId;
  const snapshot = getProviderQuotaService().getSnapshot(instance.provider as ProviderId, profile);
  return resolveCacheTtlMs(instance, resolveBillingMode(instance.provider, snapshot), getCopilotCreditRecorder().getCopilotCacheState(instance.id));
}
/** Returns false for helper readings so they cannot replace the context ring. */
export function recordInstanceContextCall(instance: Instance | undefined, usage: unknown): boolean {
  const call = usage as { mainThread?: boolean; uncachedInput?: number; cacheRead?: number; cacheWrite?: number; callId?: string };
  if (call.mainThread === false) return false;
  try {
  if (instance && instance.provider === 'claude' && typeof call.uncachedInput === 'number'
    && typeof call.cacheRead === 'number' && typeof call.cacheWrite === 'number') {
    getCacheAnalyticsService().recordCall(instance.id, { uncachedInput: call.uncachedInput, cacheRead: call.cacheRead,
      cacheWrite: call.cacheWrite, mainThread: true, model: instance.currentModel, provider: instance.provider,
      ttlMs: instanceCacheTtlMs(instance),
      // Provider call identity: several assistant frames of one model call
      // share it, and the analytics account the call only once.
      ...(typeof call.callId === 'string' && call.callId ? { callId: call.callId } : {}) });
  }
  } catch { /* Analytics must never interrupt provider output. */ }
  return true;
}
