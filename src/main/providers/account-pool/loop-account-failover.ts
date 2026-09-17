/**
 * Account failover for Loop Mode (decision D9).
 *
 * A loop does not run through the instance communication funnel: each
 * iteration spawns (or reuses) an adapter the loop invoker owns. So instead of
 * a runtime handoff, a loop fails over by benching the exhausted profile in the
 * ledger and recycling its persistent same-session adapter: the next
 * iteration's spawn resolves the pool's default again, which skips the parked
 * profile. The invoker reports which account each iteration's adapter used.
 */

import type { PooledProvider } from '../../../shared/types/provider-account.types';
import { isPooledProvider, pooledProviderLabel } from '../../../shared/types/provider-account.types';
import { getProviderLimitLedgerPort } from '../../core/system/provider-limit-ledger';
import { getNotificationService } from '../../notifications/notification-service';
import { getLogger } from '../../logging/logger';
import { readAccountQuotaEvidence } from './account-quota-evidence';
import { getAdapterAccountRoute } from './adapter-account-routes';
import { getProviderAccountBindingService } from './provider-account-binding-service';
import { emitProviderAccountEvent } from './provider-account-events';
import { selectAccount, type AccountQuotaEvidence } from './provider-account-selector';
import { getProviderAccountStore, type ProviderAccountStore } from './provider-account-store';

const logger = getLogger('LoopAccountFailover');

interface LoopAccountState {
  provider: PooledProvider;
  profileId: string;
  lastSwitchAt: number;
  switchesThisIteration: number;
  iteration: number;
}

export interface LoopAccountFailoverDeps {
  store?: () => Pick<ProviderAccountStore, 'listProfiles' | 'getPoolPolicy' | 'getProfile'>;
  cachedBindingState?: (provider: PooledProvider, profileId: string) => string | undefined;
  getParkedProfileIds?: (provider: PooledProvider, model: string | null) => string[];
  getParkedSince?: (provider: PooledProvider, model: string | null) => ReadonlyMap<string, number>;
  getQuotaEvidence?: (provider: PooledProvider, profileId: string) => AccountQuotaEvidence | null;
  notify?: (input: { kind: string; title: string; body: string }) => void;
  now?: () => number;
}

export class LoopAccountFailover {
  private readonly accounts = new Map<string, LoopAccountState>();
  private readonly recyclers = new Map<string, () => Promise<void> | void>();

  constructor(private readonly deps: LoopAccountFailoverDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Record the account a loop iteration's adapter ran on. */
  noteIterationAdapter(loopRunId: string, adapter: unknown): void {
    const route = getAdapterAccountRoute(adapter);
    if (!route) return;
    const previous = this.accounts.get(loopRunId);
    this.accounts.set(loopRunId, {
      provider: route.provider,
      profileId: route.profileId,
      lastSwitchAt: previous?.lastSwitchAt ?? 0,
      switchesThisIteration: previous?.switchesThisIteration ?? 0,
      iteration: previous?.iteration ?? 0,
    });
  }

  /** How the invoker drops a loop's persistent adapter so the next iteration re-routes. */
  registerRecycler(loopRunId: string, recycle: () => Promise<void> | void): void {
    this.recyclers.set(loopRunId, recycle);
  }

  currentProfileId(loopRunId: string, provider: string): string | null {
    const state = this.accounts.get(loopRunId);
    return state && state.provider === provider ? state.profileId : null;
  }

  clear(loopRunId: string): void {
    this.accounts.delete(loopRunId);
    this.recyclers.delete(loopRunId);
  }

  /**
   * Switch the loop away from its exhausted account when the pool allows it.
   * Returns false (park as before) for no pool, `ask`/`off` mode, an
   * unacknowledged pool, the cooldown or per-iteration cap, or no candidate.
   * `allowCredits` false (the loop's paid-overage setting is off) skips an
   * account that could run only on purchased credits.
   */
  trySwitch(params: {
    loopRunId: string;
    provider: string;
    model: string | null;
    iteration: number;
    reason: string;
    allowCredits?: boolean;
  }): boolean {
    if (!isPooledProvider(params.provider)) return false;
    const current = this.accounts.get(params.loopRunId);
    if (!current || current.provider !== params.provider) return false;
    let store: Pick<ProviderAccountStore, 'listProfiles' | 'getPoolPolicy' | 'getProfile'>;
    try {
      store = (this.deps.store ?? getProviderAccountStore)();
    } catch {
      return false;
    }
    const profiles = store.listProfiles(params.provider);
    if (!profiles.some((profile) => !profile.isLegacy)) return false;
    const policy = store.getPoolPolicy(params.provider);
    // A loop has nobody to accept an offer, so only an acknowledged automatic pool switches.
    if (policy.failoverMode !== 'automatic' || policy.acknowledgedOwnershipAt === null) return false;

    const now = this.now();
    const switchesThisIteration = current.iteration === params.iteration ? current.switchesThisIteration : 0;
    const cap = Math.min(policy.maxSwitchesPerTurn, profiles.length - 1);
    if (switchesThisIteration >= cap) return false;
    if (current.lastSwitchAt > 0 && now - current.lastSwitchAt < policy.switchCooldownMs) return false;

    const bindingState = this.deps.cachedBindingState
      ?? ((provider, profileId) => getProviderAccountBindingService().getCached(provider, profileId)?.state);
    const bindings = new Map(profiles.map((profile) => [profile.id, (bindingState(params.provider as PooledProvider, profile.id) ?? 'authenticated') as 'authenticated']));
    const quotaByProfile = new Map<string, AccountQuotaEvidence>();
    for (const profile of profiles) {
      const evidence = (this.deps.getQuotaEvidence ?? readAccountQuotaEvidence)(params.provider, profile.id);
      if (evidence) quotaByProfile.set(profile.id, evidence);
    }
    const parked = (this.deps.getParkedProfileIds
      ?? ((provider, model) => getProviderLimitLedgerPort().getParkedProfileIds({ provider, model })))(params.provider, params.model);
    const parkedSince = (this.deps.getParkedSince
      ?? ((provider, model) => getProviderLimitLedgerPort().getParkedSince({ provider, model })))(params.provider, params.model);
    const selection = selectAccount({
      profiles,
      origin: 'loop',
      exclude: [current.profileId],
      parkedProfileIds: parked,
      parkedSince,
      allowCredits: params.allowCredits ?? false,
      bindings,
      quotaByProfile,
      thresholdPct: null,
    });
    if (selection.profileId === null) {
      emitProviderAccountEvent({ event: 'account_pool_exhausted', provider: params.provider, fromProfileId: current.profileId, instanceId: params.loopRunId });
      return false;
    }

    this.accounts.set(params.loopRunId, {
      ...current,
      // The next iteration's spawn re-routes (and noteIterationAdapter corrects
      // this); until then quota checks look at the account the loop is moving to.
      profileId: selection.profileId,
      lastSwitchAt: now,
      switchesThisIteration: switchesThisIteration + 1,
      iteration: params.iteration,
    });
    const recycle = this.recyclers.get(params.loopRunId);
    if (recycle) {
      void Promise.resolve(recycle()).catch((error: unknown) => {
        logger.warn('Could not recycle the loop adapter after an account switch', {
          loopRunId: params.loopRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const from = store.getProfile(params.provider, current.profileId);
    const to = store.getProfile(params.provider, selection.profileId);
    emitProviderAccountEvent({
      event: 'account_failover_performed',
      provider: params.provider,
      profileId: selection.profileId,
      fromProfileId: current.profileId,
      handoffKind: 'failover',
      instanceId: params.loopRunId,
    });
    try {
      (this.deps.notify ?? ((input) => getNotificationService().notify({ ...input, urgency: 'normal' })))({
        kind: 'account-switched',
        title: 'Loop account switched',
        body: `${from?.label ?? current.profileId} → ${to?.label ?? selection.profileId} (${pooledProviderLabel(params.provider)} usage limit). The loop continues on the next iteration.`,
      });
    } catch {
      // best-effort
    }
    return true;
  }
}

let instance: LoopAccountFailover | null = null;

export function getLoopAccountFailover(): LoopAccountFailover {
  instance ??= new LoopAccountFailover();
  return instance;
}

export function _resetLoopAccountFailoverForTesting(next?: LoopAccountFailover): void {
  instance = next ?? null;
}
