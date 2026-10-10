/**
 * Reduces a profile's quota snapshot to the facts account selection uses:
 * Five-hour, weekly and effective MiMo allowance utilisation, the weekly reset time, and whether the
 * provider says the account can run a turn at all (included usage or
 * purchased credits).
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
  let weeklyPct: number | null = null;
  let weeklyResetsAt: number | null = null;
  let allowancePct: number | null = null;
  let compensationPct: number | null = null;
  for (const window of snapshot.windows) {
    if (window.limit <= 0) continue;
    const duration = knownWindowDurationMs(window);
    const pct = (window.used / window.limit) * 100;
    if (!Number.isFinite(pct)) continue;
    if (snapshot.provider === 'opencode' && window.kind === 'calendar-period') {
      if (window.id === 'opencode.plan' || window.id === 'opencode.monthly') {
        allowancePct = Math.max(allowancePct ?? 0, pct);
      } else if (window.id === 'opencode.compensation') {
        compensationPct = pct;
      }
    }
    if (duration === FIVE_HOUR_MS) {
      fiveHourPct = Math.max(fiveHourPct ?? 0, pct);
    } else if (duration === WEEK_MS) {
      weeklyPct = Math.max(weeklyPct ?? 0, pct);
      if (window.resetsAt !== null) {
        weeklyResetsAt = weeklyResetsAt === null ? window.resetsAt : Math.min(weeklyResetsAt, window.resetsAt);
      }
    }
  }

  // Granted compensation is free allowance after a plan/monthly cap is spent.
  // It is not purchased credits, and a spent compensation bucket must never
  // veto an account whose ordinary plan still has room.
  if ((allowancePct ?? 100) >= 100 && compensationPct !== null) {
    allowancePct = compensationPct;
  }
  const access = snapshot.usageAccess;
  const planExhausted = (fiveHourPct ?? 0) >= 100 || (weeklyPct ?? 0) >= 100 || (allowancePct ?? 0) >= 100;
  let usable: boolean | null = null;
  let creditsOnly = false;
  if (access?.ordinaryUsageAllowed === true) {
    usable = true;
  } else if (access?.ordinaryUsageAllowed === false || planExhausted) {
    if (access?.creditsAvailable === true) {
      usable = true;
      creditsOnly = true;
    } else if (access?.ordinaryUsageAllowed === false || access?.creditsAvailable === false) {
      usable = false;
    }
  }

  // Calendar counters can veto exhaustion, but cannot prove a rate-limit
  // park is lifted. Only an explicit usageAccess verdict can do that.
  if ((allowancePct ?? 0) >= 100 && usable === null) usable = false;
  if (fiveHourPct === null && weeklyPct === null && weeklyResetsAt === null && allowancePct === null && usable === null) return null;
  return { fiveHourPct, weeklyPct, weeklyResetsAt, ...(allowancePct === null ? {} : { allowancePct }), usable, creditsOnly, observedAt: access?.observedAt ?? snapshot.takenAt };
}

export function readAccountQuotaEvidence(provider: PooledProvider, profileId: string): AccountQuotaEvidence | null {
  return quotaEvidenceFromSnapshot(getProviderQuotaService().getSnapshot(provider, profileId));
}
