import type { ProviderId } from '../../shared/types/provider-quota.types';
import { isLogicalMiMoModel } from '../../shared/types/provider-account.types';

/** Classify the actual regular-session model; account stamps alone cannot identify MiMo. */
export function instanceProviderLimitScope(provider: ProviderId, requestedModel: string | null | undefined, profile: string | null = null) {
  if (provider !== 'opencode') {
    return { model: requestedModel ?? null, recordModel: requestedModel ?? null, accountProfileId: profile,
      recordable: true, quotaApplies: true, ledgerOptions: {} };
  }
  const trimmed = requestedModel?.trim();
  const model = trimmed && trimmed.toLowerCase() !== 'auto' ? trimmed : null;
  const mimo = isLogicalMiMoModel(model);
  return {
    model,
    // New MiMo signals are account-wide; lookup/clear retain historical logical-model rows.
    recordModel: mimo ? null : model,
    accountProfileId: mimo ? profile : null,
    recordable: model !== null,
    quotaApplies: mimo,
    ledgerOptions: mimo ? {} : { includeAccountWideFallback: false },
  };
}
