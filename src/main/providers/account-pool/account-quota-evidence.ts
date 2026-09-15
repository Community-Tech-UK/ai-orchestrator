/**
 * Reduces a profile's quota snapshot to the two facts account selection uses:
 * 5-hour window utilisation and the weekly window's reset time.
 */

import type { ProviderQuotaSnapshot } from '../../../shared/types/provider-quota.types';
import type { PooledProvider } from '../../../shared/types/provider-account.types';
import { getProviderQuotaService, knownWindowDurationMs } from '../../core/system/provider-quota-service';
import type { AccountQuotaEvidence } from './provider-account-selector';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function quotaEvidenceFromSnapshot(snapshot: ProviderQuotaSnapshot | null): AccountQuotaEvidence | null {
  if (!snapshot?.ok) return null;
  let fiveHourPct: number | null = null;
  let weeklyResetsAt: number | null = null;
  for (const window of snapshot.windows) {
    if (window.limit <= 0) continue;
    const duration = knownWindowDurationMs(window);
    const pct = (window.used / window.limit) * 100;
    if (duration === FIVE_HOUR_MS) {
      fiveHourPct = Math.max(fiveHourPct ?? 0, pct);
    } else if (duration === WEEK_MS && window.resetsAt !== null) {
      weeklyResetsAt = weeklyResetsAt === null ? window.resetsAt : Math.min(weeklyResetsAt, window.resetsAt);
    }
  }
  return fiveHourPct === null && weeklyResetsAt === null ? null : { fiveHourPct, weeklyResetsAt };
}

export function readAccountQuotaEvidence(provider: PooledProvider, profileId: string): AccountQuotaEvidence | null {
  return quotaEvidenceFromSnapshot(getProviderQuotaService().getSnapshot(provider, profileId));
}
