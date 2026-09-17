/**
 * Pure account selection for provider account pools (spec §8.1 step 3, §8.2
 * step 2). No I/O: the routing service and failover coordinator gather the
 * evidence (bindings, ledger, quota) and this decides.
 *
 * Eligibility, in order, each with a named veto: enabled → automation policy
 * for the origin → not excluded → binding authenticated → not parked (unless
 * the provider has since said the account can run) → has usage left: the
 * provider's own verdict when it gives one, else the 5-hour and weekly
 * windows under 100% → not credits-only when paid credits are disallowed →
 * (pre-emptive) under the threshold.
 *
 * Usage left includes purchased credits: an account whose plan window is
 * spent but which has a top-up can run, and the CLI bills the credits.
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
  /** Weekly window utilisation, 0..100, when known. */
  weeklyPct?: number | null;
  /** Weekly window reset, epoch ms, when known. */
  weeklyResetsAt?: number | null;
  /**
   * The provider's verdict that the account can (true) or cannot (false) run
   * a turn, counting purchased credits. Null/absent when it gave none; the
   * windows decide then.
   */
  usable?: boolean | null;
  /** The account can run only by spending purchased credits. */
  creditsOnly?: boolean;
  /** Epoch ms the verdict was observed. */
  observedAt?: number | null;
}

export interface SelectAccountInput {
  profiles: readonly ProviderAccountProfile[];
  origin: AccountInvocationOrigin;
  exclude?: readonly string[];
  parkedProfileIds: readonly string[];
  /**
   * When each parked profile's newest limit was recorded (epoch ms). A park is
   * lifted for a profile whose usage verdict was observed after it; without
   * an entry a park always holds.
   */
  parkedSince?: ReadonlyMap<string, number>;
  /** Whether an account that can run only on purchased credits is eligible. Defaults to true. */
  allowCredits?: boolean;
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

/**
 * A recorded limit (ledger park) is out of date when the provider has since
 * said the account can run: a top-up or reset credit lifts a limit long
 * before its recorded reset time. Only an explicit verdict observed after the
 * limit was recorded counts; window percentages alone never lift a park.
 */
export function evidenceLiftsPark(
  evidence: AccountQuotaEvidence | null | undefined,
  parkedSince: number | undefined,
  options: { allowCredits: boolean },
): boolean {
  if (evidence?.usable !== true || parkedSince === undefined) return false;
  if (typeof evidence.observedAt !== 'number' || evidence.observedAt <= parkedSince) return false;
  return options.allowCredits || evidence.creditsOnly !== true;
}

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
  const quota = input.quotaByProfile?.get(profile.id);
  const allowCredits = input.allowCredits ?? true;
  if (
    input.parkedProfileIds.includes(profile.id)
    && !evidenceLiftsPark(quota, input.parkedSince?.get(profile.id), { allowCredits })
  ) {
    return 'parked';
  }
  const fiveHour = quota?.fiveHourPct;
  if (quota?.usable === false) return 'exhausted';
  if (quota?.usable !== true && ((fiveHour ?? 0) >= 100 || (quota?.weeklyPct ?? 0) >= 100)) return 'exhausted';
  if (quota?.creditsOnly === true && !allowCredits) return 'credits-only';
  if (typeof input.thresholdPct === 'number') {
    // Moving ahead of a limit onto an account that would bill credits defeats the point.
    if (quota?.creditsOnly === true) return 'over-threshold';
    if (typeof fiveHour === 'number' && fiveHour >= input.thresholdPct) return 'over-threshold';
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
