/**
 * Account sections for the provider quota chip.
 *
 * A provider can be signed in more than once: its existing sign-in (the
 * provider-level snapshot) plus extra account-pool profiles (account
 * snapshots). Both the collapsed strip and the popover answer the same
 * question — which accounts are shown, in what order, under what name — so
 * those rules live here once, matching the standalone token-usage-monitor:
 *
 * - The existing sign-in comes first, then extra accounts in pool priority
 *   order, so a refresh never reshuffles the rows.
 * - A provider with only its existing sign-in stays unlabelled. Otherwise
 *   every section is labelled, including a lone extra account, so it is never
 *   mistaken for the existing sign-in.
 * - A disabled account is still shown (its quota is what you check before
 *   re-enabling it) and is labelled as disabled.
 * - Once the account list has loaded, accounts no longer in it are dropped.
 */

import { POOLED_PROVIDERS } from '../../../../../shared/types/provider-account.types';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../../../../shared/types/provider-quota.types';
import type { ProviderAccountView } from '../../../core/services/ipc/provider-account-ipc.service';

export type QuotaAccountProfile = Pick<ProviderAccountView, 'id' | 'provider' | 'label' | 'enabled' | 'isLegacy' | 'priority'>;

export interface QuotaAccountSection {
  /** `legacy` for the existing sign-in, otherwise the account profile id. */
  id: string;
  /** Null only when the existing sign-in is the provider's sole section. */
  label: string | null;
  snapshot: ProviderQuotaSnapshot;
}

export const LEGACY_SECTION_ID = 'legacy';
const LEGACY_FALLBACK_LABEL = 'Existing sign-in';

/**
 * @param profiles Account profiles from the account IPC, or null while they
 *   are unknown (not loaded yet, or the load failed). Unknown profiles keep
 *   every account snapshot, labelled by profile id.
 */
export function quotaAccountSections(
  provider: ProviderId,
  providerSnapshot: ProviderQuotaSnapshot | null,
  accountSnapshots: readonly ProviderQuotaSnapshot[],
  profiles: readonly QuotaAccountProfile[] | null,
): QuotaAccountSection[] {
  const ownProfiles = profiles?.filter((profile) => profile.provider === provider) ?? null;
  const filterByProfiles = ownProfiles !== null && (POOLED_PROVIDERS as readonly ProviderId[]).includes(provider);
  const extras = accountSnapshots
    .filter((snap): snap is ProviderQuotaSnapshot & { accountProfileId: string } =>
      snap.provider === provider && typeof snap.accountProfileId === 'string' && snap.accountProfileId !== LEGACY_SECTION_ID)
    .map((snap) => ({ snap, profile: ownProfiles?.find((candidate) => candidate.id === snap.accountProfileId) }))
    .filter((entry) => !filterByProfiles || entry.profile !== undefined)
    .sort((a, b) =>
      (a.profile?.priority ?? Number.MAX_SAFE_INTEGER) - (b.profile?.priority ?? Number.MAX_SAFE_INTEGER)
      || a.snap.accountProfileId.localeCompare(b.snap.accountProfileId));

  const labelled = extras.length > 0;
  const sections: QuotaAccountSection[] = [];
  if (providerSnapshot) {
    const legacyLabel = ownProfiles?.find((profile) => profile.isLegacy)?.label.trim();
    sections.push({
      id: LEGACY_SECTION_ID,
      label: labelled ? legacyLabel || LEGACY_FALLBACK_LABEL : null,
      snapshot: providerSnapshot,
    });
  }
  for (const { snap, profile } of extras) {
    const name = profile?.label.trim() || snap.accountProfileId;
    sections.push({
      id: snap.accountProfileId,
      label: profile?.enabled === false ? `${name} (disabled)` : name,
      snapshot: snap,
    });
  }
  return sections;
}
