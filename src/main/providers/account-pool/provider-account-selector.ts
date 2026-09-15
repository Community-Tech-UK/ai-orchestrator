/**
 * Pure account selection for provider account pools (spec §8.1 step 3, §8.2
 * step 2). No I/O: the routing service and failover coordinator gather the
 * evidence (bindings, ledger, quota) and this decides.
 *
 * Eligibility, in order, each with a named veto: enabled → automation policy
 * for the origin → not excluded → binding authenticated → not parked → 5-hour
 * window not exhausted → (pre-emptive) under the threshold.
 *
 * Ordering: priority ascending (stay on the preferred account until it is
 * rejected), then the soonest weekly reset ("consume-first"), then least
 * recently used. Never round-robin.
 */

import type {
  AccountBindingState,
  AccountInvocationOrigin,
  AccountVetoReason,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { isAutomaticAccountOrigin } from '../../../shared/types/provider-account.types';

export interface AccountQuotaEvidence {
  /** 5-hour window utilisation, 0..100, when known. */
  fiveHourPct?: number | null;
  /** Weekly window reset, epoch ms, when known. */
  weeklyResetsAt?: number | null;
}

export interface SelectAccountInput {
  profiles: readonly ProviderAccountProfile[];
  origin: AccountInvocationOrigin;
  exclude?: readonly string[];
  parkedProfileIds: readonly string[];
  /** Binding state per profile id. A missing entry is treated as not verified (`unbound`). */
  bindings: ReadonlyMap<string, AccountBindingState>;
  /** Skip binding vetoes (remote placement: the worker verifies its own binding). */
  ignoreBindings?: boolean;
  quotaByProfile?: ReadonlyMap<string, AccountQuotaEvidence>;
  lastUsedAt?: ReadonlyMap<string, number>;
  /** Apply the pre-emptive threshold (new sessions, or a live pre-emptive switch). */
  thresholdPct?: number | null;
}

export interface ConsideredAccount {
  profileId: string;
  vetoReason: AccountVetoReason;
}

export type SelectAccountResult =
  | { profileId: string; reasons: string[]; considered: ConsideredAccount[] }
  | { profileId: null; considered: ConsideredAccount[] };

export function accountVetoFor(
  profile: ProviderAccountProfile,
  input: SelectAccountInput,
): AccountVetoReason | null {
  if (!profile.enabled) return 'disabled';
  if (
    profile.automationPolicy === 'disabled'
    || (profile.automationPolicy === 'manual-only' && isAutomaticAccountOrigin(input.origin))
  ) {
    return 'automation-disallowed';
  }
  if (input.exclude?.includes(profile.id)) return 'excluded';
  if (!input.ignoreBindings && input.bindings.get(profile.id) !== 'authenticated') return 'unbound';
  if (input.parkedProfileIds.includes(profile.id)) return 'parked';
  const quota = input.quotaByProfile?.get(profile.id);
  const fiveHour = quota?.fiveHourPct;
  if (typeof fiveHour === 'number' && fiveHour >= 100) return 'exhausted';
  if (typeof input.thresholdPct === 'number' && typeof fiveHour === 'number' && fiveHour >= input.thresholdPct) {
    return 'over-threshold';
  }
  return null;
}

/** Candidates in selection order. Stable for equal keys. */
export function orderAccountCandidates(
  profiles: readonly ProviderAccountProfile[],
  input: Pick<SelectAccountInput, 'quotaByProfile' | 'lastUsedAt'>,
): ProviderAccountProfile[] {
  const weekly = (profile: ProviderAccountProfile): number =>
    input.quotaByProfile?.get(profile.id)?.weeklyResetsAt ?? Number.POSITIVE_INFINITY;
  const lastUsed = (profile: ProviderAccountProfile): number => input.lastUsedAt?.get(profile.id) ?? 0;
  return [...profiles].sort((a, b) =>
    a.priority - b.priority || weekly(a) - weekly(b) || lastUsed(a) - lastUsed(b));
}

export function selectAccount(input: SelectAccountInput): SelectAccountResult {
  const considered: ConsideredAccount[] = [];
  for (const profile of orderAccountCandidates(input.profiles, input)) {
    const veto = accountVetoFor(profile, input);
    if (veto) {
      considered.push({ profileId: profile.id, vetoReason: veto });
      continue;
    }
    const reasons = [`priority ${profile.priority}`];
    const weeklyResetsAt = input.quotaByProfile?.get(profile.id)?.weeklyResetsAt;
    if (typeof weeklyResetsAt === 'number') reasons.push('weekly window resets soonest among equals');
    return { profileId: profile.id, reasons, considered };
  }
  return { profileId: null, considered };
}
