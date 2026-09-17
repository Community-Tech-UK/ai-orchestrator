/**
 * Whether a recorded provider limit still holds, judged from quota evidence.
 *
 * A limit's recorded reset time is only what the provider said when a turn
 * was rejected. It stops being true early when a reset credit is applied or
 * credits are bought, and a fresh snapshot is how Harness notices.
 */

import type { ProviderLimitLedger } from '../core/system/provider-limit-ledger';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../shared/types/provider-account.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import { quotaEvidenceFromSnapshot } from '../providers/account-pool/account-quota-evidence';
import { evidenceLiftsPark } from '../providers/account-pool/provider-account-selector';

/**
 * A parked limit counts as lifted when a fresh, successful snapshot says so.
 * The provider's own usage verdict wins when it gives one: included usage
 * allowed lifts it, not allowed holds it. `acceptCredits` also lifts it when
 * purchased credits can pay (for a session the user attends; unattended
 * resumes must not start spending). Without a verdict, every window needs
 * headroom (a reset credit zeroes the exhausted window; other windows may
 * still be pinned). An errored/absent snapshot or one with no windows proves
 * nothing and keeps the park. Used by the regular-session early-resume probe
 * and the provider-limit resume automation reconciler.
 */
export function snapshotShowsLimitLifted(
  snapshot: ProviderQuotaSnapshot | null,
  options: { acceptCredits?: boolean } = {},
): boolean {
  if (!snapshot || !snapshot.ok) return false;
  const access = snapshot.usageAccess;
  if (options.acceptCredits && access?.creditsAvailable === true) return true;
  if (access?.ordinaryUsageAllowed === true) return true;
  if (access?.ordinaryUsageAllowed === false) return false;
  if (snapshot.windows.length === 0) return false;
  return snapshot.windows.every((w) => w.limit <= 0 || w.used < w.limit);
}

/**
 * Clear the recorded limits holding a send for this account when the
 * provider has said, after the newest of them was recorded, that the account
 * can run (usage allowed, or purchased credits available). Returns null when
 * the limit still holds or the ledger cannot tell when it was recorded. If
 * the account is in fact still limited, the rejected turn records a fresh one.
 */
export function clearLimitLiftedSinceRecorded(params: {
  ledger: Pick<ProviderLimitLedger, 'clearActive'> & Partial<Pick<ProviderLimitLedger, 'getParkedSince'>>;
  snapshot: ProviderQuotaSnapshot | null;
  provider: ProviderId;
  model: string | null;
  accountProfileId: string | null;
}): { cleared: number; creditsOnly: boolean } | null {
  const { ledger, provider, model, accountProfileId } = params;
  if (!ledger.getParkedSince) return null;
  // Judge against every limit the clear below removes: for a null model that is all of the account's models.
  const since = ledger.getParkedSince({ provider, model, anyModel: model === null }).get(accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID);
  const evidence = quotaEvidenceFromSnapshot(params.snapshot);
  if (!evidenceLiftsPark(evidence, since, { allowCredits: true })) return null;
  return {
    cleared: ledger.clearActive({ provider, model, accountProfileId }),
    creditsOnly: evidence?.creditsOnly === true,
  };
}
