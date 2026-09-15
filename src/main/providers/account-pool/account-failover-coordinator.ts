/**
 * AccountFailoverCoordinator — moves a conversation to another account of the
 * same provider when its account hits a usage limit (spec §8.2).
 *
 * Sits in the provider-limit funnel between the ledger record (for the
 * exhausted profile) and `park()`. Two halves:
 *
 *  - `plan()` is SYNCHRONOUS and cheap (settings + ledger + cached quota): it
 *    decides whether a switch should be attempted at all, so the funnel can
 *    answer the adapter's turn without awaiting. It never picks the target.
 *  - `perform()` is async: under a per-provider lock it re-reads the ledger,
 *    verifies bindings, selects the target, applies a `DesiredRuntime` with
 *    `accountHandoffKind: 'failover'` through the runtime reconciler, and
 *    re-sends the throttled turn once. With no candidate it hands back to the
 *    caller's park.
 *
 * Guardrails: failover mode, the ownership acknowledgement, a per-turn switch
 * cap (also bounded by profile count - 1), the switch cooldown, one decision
 * per provider at a time, and a short storm ramp on a freshly chosen target.
 */

import type {
  AccountBindingState,
  AccountHandoffKind,
  AccountInvocationOrigin,
  PooledProvider,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { LEGACY_ACCOUNT_PROFILE_ID, isPooledProvider, pooledProviderLabel } from '../../../shared/types/provider-account.types';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import { isModelSwitchAllowedStatus } from '../../../shared/types/instance-status-policy';
import { getLogger } from '../../logging/logger';
import { emitProviderAccountEvent } from './provider-account-events';
import {
  selectAccount,
  type AccountQuotaEvidence,
  type ConsideredAccount,
} from './provider-account-selector';
import type { ProviderAccountStore } from './provider-account-store';
import type { ProviderAccountBindingService } from './provider-account-binding-service';

const logger = getLogger('AccountFailoverCoordinator');

const STORM_WINDOW_MS = 30_000;
const STORM_STEP_MS = 250;
const STORM_MAX_DELAY_MS = 5_000;
const IDLE_WAIT_MS = 5_000;
const IDLE_POLL_MS = 50;
/** Turns re-sent by switches, remembered per instance so a duplicate report of one adds no note. */
const DELIVERED_PROMPT_MEMORY = 16;
/** A report matches a re-sent turn only this soon after it; identical text later is a new turn. */
const DELIVERED_PROMPT_MATCH_MS = 60_000;

export interface AccountFailoverParams {
  instanceId: string;
  provider: PooledProvider;
  model: string | null;
  /** The profile that was just rejected (`legacy` for an unstamped session). */
  exhaustedProfileId: string;
  resumeAt: number | null;
  /** The throttled user turn to re-send after the switch. */
  resumePrompt: string | null;
  reason: string;
  handoffKind?: Extract<AccountHandoffKind, 'failover' | 'preemptive'>;
}

/** 5-hour utilisation at/above which a live session counts as "approaching" its limit. */
function preemptiveThreshold(policy: { preemptive: { thresholdPct: number } }): number {
  return policy.preemptive.thresholdPct;
}

export type AccountFailoverPlan =
  | { kind: 'switch' }
  | { kind: 'offer'; toProfileId: string }
  | { kind: 'none'; reason: 'no-pool' | 'mode-off' | 'cap-reached' | 'cooldown' | 'no-candidate' };

export type AccountFailoverOutcome =
  | { outcome: 'switched'; toProfileId: string; continuity: 'native-resume' | 'replay' }
  | { outcome: 'offered'; toProfileId: string }
  /**
   * The instance had already left the exhausted profile. `turnNotSent` is true
   * when the reported turn is not one a switch re-sent: it is deliberately not
   * sent automatically (it could race the running turn or repeat a cancelled
   * one), and the caller tells the user to send it again.
   */
  | { outcome: 'already-moved'; toProfileId: string; turnNotSent: boolean }
  | {
      outcome: 'not-switched';
      reason: 'no-pool' | 'mode-off' | 'cap-reached' | 'cooldown' | 'no-candidate' | 'busy' | 'apply-failed';
      considered: ConsideredAccount[];
    };

export interface AccountFailoverDeps {
  store: () => ProviderAccountStore;
  bindings: () => ProviderAccountBindingService;
  getParkedProfileIds: (provider: PooledProvider, model: string | null) => string[];
  getQuotaEvidence: (provider: PooledProvider, profileId: string) => AccountQuotaEvidence | null;
  getInstance: (instanceId: string) => Instance | undefined;
  applyRuntimeChange: (instanceId: string, desired: DesiredRuntime) => Promise<Instance>;
  resendInput: (instanceId: string, prompt: string) => void;
  notify: (input: { kind: string; instanceId: string; title: string; body: string }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface TurnSwitchState {
  prompt: string | null;
  count: number;
  lastSwitchAt: number;
}

export class AccountFailoverCoordinator {
  private readonly locks = new Map<PooledProvider, Promise<void>>();
  private readonly turnState = new Map<string, TurnSwitchState>();
  /** Recent target selections per `provider:profileId`, for the storm ramp. */
  private readonly recentTargets = new Map<string, number[]>();
  private readonly lastUsedAt = new Map<string, number>();
  private readonly deliveredPrompts = new Map<string, Array<{ prompt: string; at: number }>>();

  constructor(private readonly deps: AccountFailoverDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Pre-emptive live-session switch at a turn boundary (spec §8.4, off by
   * default): the session's account is at or above the pool threshold on its
   * 5-hour window and another account is under it. Only in automatic,
   * acknowledged pools; never offered.
   */
  shouldSwitchPreemptively(params: AccountFailoverParams): boolean {
    try {
      const store = this.deps.store();
      const policy = store.getPoolPolicy(params.provider);
      if (!policy.preemptive.liveSessionsAtTurnBoundary) return false;
      if (policy.failoverMode !== 'automatic' || policy.acknowledgedOwnershipAt === null) return false;
      const evidence = this.deps.getQuotaEvidence(params.provider, params.exhaustedProfileId);
      if (typeof evidence?.fiveHourPct !== 'number' || evidence.fiveHourPct < preemptiveThreshold(policy)) return false;
      const plan = this.plan({ ...params, handoffKind: 'preemptive' });
      return plan.kind === 'switch';
    } catch {
      return false;
    }
  }

  /** Synchronous gate: should a switch be attempted for this rejection? */
  plan(params: AccountFailoverParams): AccountFailoverPlan {
    let profiles: ProviderAccountProfile[];
    let policy;
    try {
      const store = this.deps.store();
      profiles = store.listProfiles(params.provider);
      policy = store.getPoolPolicy(params.provider);
    } catch {
      return { kind: 'none', reason: 'no-pool' };
    }
    if (!profiles.some((profile) => !profile.isLegacy)) return { kind: 'none', reason: 'no-pool' };
    if (policy.failoverMode === 'off') return { kind: 'none', reason: 'mode-off' };

    const turn = this.turnState.get(params.instanceId);
    const sameTurn = turn !== undefined && turn.prompt === params.resumePrompt;
    const cap = Math.min(policy.maxSwitchesPerTurn, Math.max(0, profiles.length - 1));
    if (sameTurn && turn.count >= cap) return { kind: 'none', reason: 'cap-reached' };
    if (cap === 0) return { kind: 'none', reason: 'cap-reached' };
    if (turn && this.now() - turn.lastSwitchAt < policy.switchCooldownMs) {
      return { kind: 'none', reason: 'cooldown' };
    }

    // Cheap eligibility with cached bindings; perform() re-verifies under the lock.
    const selection = this.select(params, profiles, { useCachedBindings: true });
    if (selection.profileId === null) return { kind: 'none', reason: 'no-candidate' };
    // Mode `ask` also needs the acknowledgement to be meaningful; before it the
    // pool behaves as `ask` regardless of the stored mode (decision D8).
    if (policy.failoverMode === 'ask' || policy.acknowledgedOwnershipAt === null) {
      return { kind: 'offer', toProfileId: selection.profileId };
    }
    return { kind: 'switch' };
  }

  /**
   * Full failover: lock, re-select with verified bindings, apply the handoff,
   * re-send the turn. Never throws.
   */
  async perform(params: AccountFailoverParams): Promise<AccountFailoverOutcome> {
    // Checked before any guardrail: a late report for a profile this instance
    // already left must not be answered with `cooldown`/`cap-reached`, which
    // the caller would turn into a park on the old profile's reset time.
    if (this.isMovedOff(params)) {
      // Through the lock, so a switch still finishing (and its own re-send) lands first.
      return this.withProviderLock(params.provider, () => this.performLocked(params));
    }
    const plan = this.plan(params);
    if (plan.kind === 'none') {
      if (plan.reason === 'no-candidate') this.emitExhausted(params);
      return { outcome: 'not-switched', reason: plan.reason, considered: [] };
    }
    if (plan.kind === 'offer') {
      this.offer(params, plan.toProfileId);
      return { outcome: 'offered', toProfileId: plan.toProfileId };
    }
    return this.withProviderLock(params.provider, () => this.performLocked(params));
  }

  /** Tell the user another account is available (mode `ask`). */
  offer(params: AccountFailoverParams, toProfileId: string): void {
    const store = this.deps.store();
    const from = store.getProfile(params.provider, params.exhaustedProfileId);
    const to = store.getProfile(params.provider, toProfileId);
    const label = pooledProviderLabel(params.provider);
    emitProviderAccountEvent({
      event: 'account_failover_offered',
      provider: params.provider,
      profileId: toProfileId,
      fromProfileId: params.exhaustedProfileId,
      ...(params.resumeAt ? { resumeAt: params.resumeAt } : {}),
      instanceId: params.instanceId,
    });
    this.safeNotify({
      kind: 'account-failover-offer',
      instanceId: params.instanceId,
      title: `${from?.label ?? label} hit its usage limit`,
      body: `${to?.label ?? 'Another account'} is available. Switch this session's account from the session header to continue now.`,
    });
  }

  private async performLocked(params: AccountFailoverParams): Promise<AccountFailoverOutcome> {
    const store = this.deps.store();
    const profiles = store.listProfiles(params.provider);
    // Another failure for this instance may have moved it off the exhausted
    // profile while we waited for the lock: one switch per exhaustion. This runs
    // before the re-plan, whose cooldown would otherwise report `not-switched`.
    const moved = this.alreadyMovedOutcome(params);
    if (moved) return moved;
    // Re-plan under the lock: the target may be parked now, or the pool policy changed.
    const replan = this.plan(params);
    if (replan.kind === 'none') return { outcome: 'not-switched', reason: replan.reason, considered: [] };
    if (replan.kind === 'offer') {
      this.offer(params, replan.toProfileId);
      return { outcome: 'offered', toProfileId: replan.toProfileId };
    }

    // Verified bindings for the enabled candidates (30 s cache inside).
    const bindingStates = new Map<string, AccountBindingState>();
    await Promise.all(profiles.filter((profile) => profile.enabled && profile.id !== params.exhaustedProfileId)
      .map(async (profile) => {
        bindingStates.set(profile.id, (await this.deps.bindings().checkBinding(profile)).state);
      }));
    const selection = this.select(params, profiles, { bindingStates });
    if (selection.profileId === null) {
      this.emitExhausted(params);
      return { outcome: 'not-switched', reason: 'no-candidate', considered: selection.considered };
    }
    const toProfileId = selection.profileId;

    if (!(await this.waitForSwitchableInstance(params.instanceId))) {
      return { outcome: 'not-switched', reason: 'busy', considered: selection.considered };
    }

    await this.stormRamp(params.provider, toProfileId);

    const from = store.getProfile(params.provider, params.exhaustedProfileId);
    const to = store.getProfile(params.provider, toProfileId);
    const resetText = params.resumeAt ? `; resets ${new Date(params.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    const handoffKind = params.handoffKind ?? 'failover';
    const instance = this.deps.getInstance(params.instanceId);
    if (!instance) return { outcome: 'not-switched', reason: 'apply-failed', considered: selection.considered };

    try {
      await this.deps.applyRuntimeChange(params.instanceId, {
        provider: instance.provider,
        accountProfileId: toProfileId,
        accountHandoffKind: handoffKind,
        accountHandoffReason: handoffKind === 'failover' ? `usage limit${resetText}` : 'approaching usage limit',
      });
    } catch (error) {
      logger.warn('Account failover could not be applied', {
        instanceId: params.instanceId,
        provider: params.provider,
        toProfileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { outcome: 'not-switched', reason: 'apply-failed', considered: selection.considered };
    }

    const turn = this.turnState.get(params.instanceId);
    const sameTurn = turn !== undefined && turn.prompt === params.resumePrompt;
    this.turnState.set(params.instanceId, {
      prompt: params.resumePrompt,
      count: sameTurn ? turn.count + 1 : 1,
      lastSwitchAt: this.now(),
    });
    this.lastUsedAt.set(`${params.provider}:${toProfileId}`, this.now());

    const updated = this.deps.getInstance(params.instanceId);
    const continuity = updated?.recoveryMethod === 'native' ? 'native-resume' : 'replay';
    emitProviderAccountEvent({
      event: 'account_failover_performed',
      provider: params.provider,
      profileId: toProfileId,
      fromProfileId: params.exhaustedProfileId,
      handoffKind,
      ...(params.resumeAt ? { resumeAt: params.resumeAt } : {}),
      instanceId: params.instanceId,
    });
    this.safeNotify({
      kind: 'account-switched',
      instanceId: params.instanceId,
      title: 'Account switched',
      body: `${from?.label ?? params.exhaustedProfileId} → ${to?.label ?? toProfileId} (${handoffKind === 'failover' ? `usage limit${resetText}` : 'approaching usage limit'}).`,
    });

    if (params.resumePrompt) {
      this.rememberDelivered(params.instanceId, params.resumePrompt);
      this.deps.resendInput(params.instanceId, params.resumePrompt);
    }
    return { outcome: 'switched', toProfileId, continuity };
  }

  private isMovedOff(params: AccountFailoverParams): boolean {
    const current = this.deps.getInstance(params.instanceId);
    return current !== undefined && (current.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID) !== params.exhaustedProfileId;
  }

  /** `already-moved` when the instance no longer runs on the exhausted profile; never sends anything. */
  private alreadyMovedOutcome(params: AccountFailoverParams): AccountFailoverOutcome | null {
    if (!this.isMovedOff(params)) return null;
    const toProfileId = this.deps.getInstance(params.instanceId)?.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID;
    const prompt = params.resumePrompt;
    const now = this.now();
    const turnNotSent = Boolean(prompt) && !this.deliveredPrompts.get(params.instanceId)
      ?.some((entry) => entry.prompt === prompt && now - entry.at < DELIVERED_PROMPT_MATCH_MS);
    return { outcome: 'already-moved', toProfileId, turnNotSent };
  }

  private rememberDelivered(instanceId: string, prompt: string): void {
    const delivered = this.deliveredPrompts.get(instanceId) ?? [];
    delivered.push({ prompt, at: this.now() });
    this.deliveredPrompts.set(instanceId, delivered.slice(-DELIVERED_PROMPT_MEMORY));
  }

  private emitExhausted(params: AccountFailoverParams): void {
    emitProviderAccountEvent({
      event: 'account_pool_exhausted',
      provider: params.provider,
      fromProfileId: params.exhaustedProfileId,
      ...(params.resumeAt ? { resumeAt: params.resumeAt } : {}),
      instanceId: params.instanceId,
    });
  }

  private select(
    params: AccountFailoverParams,
    profiles: ProviderAccountProfile[],
    options: { useCachedBindings?: boolean; bindingStates?: Map<string, AccountBindingState> },
  ): ReturnType<typeof selectAccount> {
    const bindingStates = options.bindingStates ?? new Map<string, AccountBindingState>();
    if (options.useCachedBindings) {
      for (const profile of profiles) {
        // Unknown (not yet checked) counts as signed in here; perform() verifies.
        bindingStates.set(profile.id, this.deps.bindings().getCached(params.provider, profile.id)?.state ?? 'authenticated');
      }
    }
    let parked: string[] = [];
    try {
      parked = this.deps.getParkedProfileIds(params.provider, params.model);
    } catch {
      parked = [];
    }
    const quotaByProfile = new Map<string, AccountQuotaEvidence>();
    for (const profile of profiles) {
      try {
        const evidence = this.deps.getQuotaEvidence(params.provider, profile.id);
        if (evidence) quotaByProfile.set(profile.id, evidence);
      } catch {
        // Quota evidence is advisory.
      }
    }
    const lastUsedAt = new Map<string, number>();
    for (const [key, at] of this.lastUsedAt) {
      if (key.startsWith(`${params.provider}:`)) lastUsedAt.set(key.slice(params.provider.length + 1), at);
    }
    const origin: AccountInvocationOrigin = 'failover';
    let thresholdPct: number | null = null;
    if (params.handoffKind === 'preemptive') {
      try {
        thresholdPct = preemptiveThreshold(this.deps.store().getPoolPolicy(params.provider));
      } catch {
        thresholdPct = null;
      }
    }
    return selectAccount({
      profiles,
      origin,
      exclude: [params.exhaustedProfileId],
      parkedProfileIds: parked,
      bindings: bindingStates,
      quotaByProfile,
      lastUsedAt,
      // A pre-emptive move only makes sense onto an account that is itself under the threshold.
      thresholdPct,
    });
  }

  private async waitForSwitchableInstance(instanceId: string): Promise<boolean> {
    const deadline = this.now() + IDLE_WAIT_MS;
    for (;;) {
      const instance = this.deps.getInstance(instanceId);
      if (!instance || instance.status === 'terminated' || instance.status === 'failed') return false;
      if (isModelSwitchAllowedStatus(instance.status)) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(IDLE_POLL_MS);
    }
  }

  private async stormRamp(provider: PooledProvider, profileId: string): Promise<void> {
    const key = `${provider}:${profileId}`;
    const now = this.now();
    const recent = (this.recentTargets.get(key) ?? []).filter((at) => now - at < STORM_WINDOW_MS);
    const delay = Math.min(STORM_MAX_DELAY_MS, recent.length * STORM_STEP_MS);
    recent.push(now);
    this.recentTargets.set(key, recent);
    if (delay > 0) await this.sleep(delay);
  }

  private async withProviderLock<T>(provider: PooledProvider, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(provider, chained);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(provider) === chained) this.locks.delete(provider);
    }
  }

  private safeNotify(input: Parameters<AccountFailoverDeps['notify']>[0]): void {
    try {
      this.deps.notify(input);
    } catch {
      // Notifications are best-effort.
    }
  }

  /** Drop per-instance switch bookkeeping (instance teardown). */
  release(instanceId: string): void {
    this.turnState.delete(instanceId);
    this.deliveredPrompts.delete(instanceId);
  }
}

/** The profile an instance currently runs on, for a pooled provider. */
export function currentAccountProfileId(instance: Pick<Instance, 'provider' | 'accountProfileId'>): string | null {
  if (!isPooledProvider(instance.provider)) return null;
  return instance.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID;
}

let instance: AccountFailoverCoordinator | null = null;

export function configureAccountFailoverCoordinator(deps: AccountFailoverDeps): AccountFailoverCoordinator {
  instance = new AccountFailoverCoordinator(deps);
  return instance;
}

export function getAccountFailoverCoordinator(): AccountFailoverCoordinator | null {
  return instance;
}

export function _resetAccountFailoverCoordinatorForTesting(): void {
  instance = null;
}
