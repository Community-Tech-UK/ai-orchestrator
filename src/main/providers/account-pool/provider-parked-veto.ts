/**
 * "Is this provider parked?" for the cross-provider failover vetoes.
 *
 * Before account pools a single ledger row parked the whole provider. With a
 * pool, a provider is parked only when EVERY eligible profile (enabled, and not
 * known to be signed out on this node) has an active limit (spec invariant 6).
 * A legacy-only provider reduces to exactly the old check.
 */

import type { ProviderId } from '../../../shared/types/provider-quota.types';
import { isPooledProvider } from '../../../shared/types/provider-account.types';
import { getProviderLimitLedgerPort, type ProviderLimitLedgerPort } from '../../core/system/provider-limit-ledger';
import { getProviderAccountBindingService, type ProviderAccountBindingService } from './provider-account-binding-service';
import { getProviderAccountStore, type ProviderAccountStore } from './provider-account-store';

export interface ProviderParkedVetoDeps {
  ledger?: Pick<ProviderLimitLedgerPort, 'getActive' | 'isProviderFullyParked'>;
  store?: Pick<ProviderAccountStore, 'listProfiles'>;
  bindings?: Pick<ProviderAccountBindingService, 'getCached'>;
  now?: number;
}

export function isProviderParkedForFailover(
  provider: string,
  model: string | null = null,
  deps: ProviderParkedVetoDeps = {},
): boolean {
  const ledger = deps.ledger ?? getProviderLimitLedgerPort();
  const now = deps.now ?? Date.now();
  if (!isPooledProvider(provider)) {
    return Boolean(ledger.getActive({ provider: provider as ProviderId, model, now }));
  }
  let eligibleProfileIds: string[] = [];
  try {
    const store = deps.store ?? getProviderAccountStore();
    const bindings = deps.bindings ?? getProviderAccountBindingService();
    eligibleProfileIds = store.listProfiles(provider)
      .filter((profile) => profile.enabled)
      .filter((profile) => {
        const cached = bindings.getCached(provider, profile.id)?.state;
        return cached === undefined || cached === 'authenticated';
      })
      .map((profile) => profile.id);
  } catch {
    eligibleProfileIds = [];
  }
  return ledger.isProviderFullyParked({ provider, model, eligibleProfileIds, now });
}
