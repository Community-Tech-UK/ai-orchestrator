import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import { getLogger } from '../logging/logger';
import type { InstanceProviderLimitHandlerDeps, MaybeParkKnownParams } from './instance-provider-limit-handler';
import { instanceProviderLimitScope } from './instance-provider-limit-scope';

const logger = getLogger('InstanceUsageLimitStop');

export interface UsageLimitStopParams {
  instanceId: string;
  resetAtHint: number | null;
  reason: string;
  resumePrompt?: string | null;
}

/** Record the exhausted account before either switching it or holding the session. */
export function resolveUsageLimitStop(
  deps: InstanceProviderLimitHandlerDeps,
  params: UsageLimitStopParams,
  assumedLimitMs: number,
): { params: MaybeParkKnownParams; providerId: ProviderId; resumeAt: number } | null {
  const info = deps.getProviderModel?.(params.instanceId) ?? null;
  if (!info || info.provider === 'auto') return null;
  const providerId = info.provider;
  const scope = instanceProviderLimitScope(providerId, info.model, info.accountProfileId);
  const now = Date.now();
  const resetAtHint = typeof params.resetAtHint === 'number' && params.resetAtHint > now
    ? params.resetAtHint : null;
  const snapshotResumeAt = deriveProviderLimitResumeFromSnapshot(
    scope.quotaApplies ? deps.getQuotaSnapshot(providerId, scope.accountProfileId) : null,
  );
  const knownLimit = deps.providerLimitLedger?.getActive({
    provider: providerId,
    model: scope.model,
    accountProfileId: scope.accountProfileId,
    ...scope.ledgerOptions,
    now,
  }) ?? null;
  const resumeAt = resetAtHint ?? snapshotResumeAt ?? knownLimit?.resumeAt ?? now + assumedLimitMs;
  try {
    if (scope.recordable) deps.providerLimitLedger?.record({
      provider: providerId,
      model: scope.recordModel,
      accountProfileId: scope.accountProfileId,
      detectedAt: now,
      resumeAt,
      source: 'usage-overage',
      instanceId: params.instanceId,
    });
  } catch (error) {
    // A durability failure must still stop spend on the exhausted account.
    logger.warn('Failed to record usage-overage stop in durable ledger', {
      instanceId: params.instanceId,
      provider: providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    providerId,
    resumeAt,
    params: {
      instanceId: params.instanceId,
      provider: info.provider,
      model: scope.model,
      accountProfileId: scope.accountProfileId,
      reason: params.reason,
      resumePrompt: params.resumePrompt ?? null,
      allowCredits: false,
    },
  };
}

/** Reset time of the most-constrained active quota window. */
export function deriveProviderLimitResumeFromSnapshot(snapshot: ProviderQuotaSnapshot | null): number | null {
  if (!snapshot || !snapshot.ok) return null;
  const now = Date.now();
  let bestResetsAt: number | null = null;
  let bestPct = -1;
  for (const window of snapshot.windows) {
    if (window.resetsAt == null || window.resetsAt <= now || window.limit <= 0) continue;
    const pct = (window.used / window.limit) * 100;
    if (pct > bestPct) {
      bestPct = pct;
      bestResetsAt = window.resetsAt;
    }
  }
  return bestResetsAt;
}
