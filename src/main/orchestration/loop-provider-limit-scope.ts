import { isLogicalMiMoModel } from '../../shared/types/provider-account.types';
import type { ProviderId } from '../../shared/types/provider-quota.types';

/** Accepted attribution travels with the limit decision, independently of mutable settings. */
export interface LoopProviderLimitScope {
  /** Accepted logical identity for lookup, candidate selection and recovery. */
  readonly model: string | null;
  readonly recordModel: string | null;
  readonly accountProfileId: string | null;
  readonly recordable: boolean;
  readonly quotaApplies: boolean;
}

export function resolveLoopProviderLimitScope(
  provider: ProviderId, model: string | null, currentProfileId: string | null,
): LoopProviderLimitScope {
  const accountProfileId = provider === 'opencode' && model !== null && !isLogicalMiMoModel(model)
    ? null : currentProfileId;
  const mimo = provider === 'opencode' && (accountProfileId !== null || isLogicalMiMoModel(model));
  return Object.freeze({
    model: provider === 'opencode' ? model : null,
    recordModel: provider === 'opencode' && !mimo ? model : null,
    accountProfileId,
    // Unknown native backends cannot alias the account-wide MiMo legacy ledger scope.
    recordable: provider !== 'opencode' || mimo || Boolean(model),
    quotaApplies: provider !== 'opencode' || mimo,
  });
}
