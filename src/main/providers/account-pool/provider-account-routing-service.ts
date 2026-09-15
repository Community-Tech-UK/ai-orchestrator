/**
 * ProviderAccountRoutingService — the async front door to account pools.
 *
 * Resolves exactly one Claude or Codex account profile before a spawn
 * (spec §8.1):
 *
 *   1. a persisted profile wins (restore, respawn, native resume): changed pool
 *      settings never move a live thread;
 *   2. an explicit profile wins for a new session;
 *   3. otherwise the pool's default: the first eligible profile in priority
 *      order, skipping parked and (pre-emptively) over-threshold profiles;
 *   4. with no pool (no profile other than legacy) the legacy route, exactly
 *      as before pools, with no sign-in check at all.
 *
 * `admit()` then verifies the chosen profile's node-local binding and refuses
 * with a typed failure. Admission never substitutes a different profile: that
 * is the pool's job in step 3, before admission.
 */

import type {
  AccountBindingState,
  AccountInvocationOrigin,
  AccountRouteFailure,
  AccountRouteOutcome,
  AccountRouteSource,
  PooledProvider,
  ProviderAccountProfile,
  ResolvedAccountRoute,
} from '../../../shared/types/provider-account.types';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  isAutomaticAccountOrigin,
  pooledProviderLabel,
} from '../../../shared/types/provider-account.types';
import { getProviderLimitLedgerPort } from '../../core/system/provider-limit-ledger';
import { getLogger } from '../../logging/logger';
import { readAccountQuotaEvidence } from './account-quota-evidence';
import {
  LOCAL_ACCOUNT_NODE_ID,
  getProviderAccountBindingService,
  type ProviderAccountBindingService,
} from './provider-account-binding-service';
import { emitProviderAccountEvent } from './provider-account-events';
import {
  selectAccount,
  type AccountQuotaEvidence,
  type ConsideredAccount,
} from './provider-account-selector';
import {
  getProviderAccountStore,
  onProviderAccountsChanged,
  type ProviderAccountStore,
} from './provider-account-store';

const logger = getLogger('ProviderAccountRouting');

export interface AccountRouteRequest {
  provider: PooledProvider;
  /** Model the session will use; scopes ledger lookups. */
  model?: string | null;
  explicitProfileId?: string;
  persistedProfileId?: string;
  origin: AccountInvocationOrigin;
  /** Defaults to the local controller node. */
  executionNodeId?: string;
  /** Apply the pool's pre-emptive threshold (new sessions). Defaults to true. */
  newSession?: boolean;
  /** Profiles that must not be chosen (failover away from them). */
  exclude?: readonly string[];
  /** Source to stamp when the default selection runs on behalf of failover. */
  defaultSource?: Extract<AccountRouteSource, 'default' | 'failover' | 'preemptive'>;
  /** Correlation only. */
  instanceId?: string;
}

export interface AccountRoutePreview {
  outcome: AccountRouteOutcome;
  considered: ConsideredAccount[];
}

export interface ProviderAccountRoutingDeps {
  store?: ProviderAccountStore;
  bindingService?: ProviderAccountBindingService;
  /** Profile ids with an active limit for this model (ledger). */
  getParkedProfileIds?: (provider: PooledProvider, model: string | null) => string[];
  getSoonestResumeAt?: (provider: PooledProvider, model: string | null, profileIds: readonly string[]) => number | null;
  getQuotaEvidence?: (provider: PooledProvider, profileId: string) => AccountQuotaEvidence | null;
  now?: () => number;
}

function failure(code: AccountRouteFailure['code'], detail: string, profileId?: string): AccountRouteFailure {
  return { ok: false, code, detail, ...(profileId ? { profileId } : {}) };
}

export class ProviderAccountRoutingService {
  private readonly lastUsedAt = new Map<string, number>();

  constructor(private readonly deps: ProviderAccountRoutingDeps = {}) {}

  private store(): ProviderAccountStore {
    return this.deps.store ?? getProviderAccountStore();
  }

  private bindings(): ProviderAccountBindingService {
    return this.deps.bindingService ?? getProviderAccountBindingService();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private lastUsedKey(provider: PooledProvider, profileId: string): string {
    return `${provider}:${profileId}`;
  }

  /** Drop cached binding health (settings change, login launch). */
  invalidate(): void {
    this.bindings().invalidate();
  }

  /** True when the provider has a pool (any profile besides legacy). */
  isPoolActive(provider: PooledProvider): boolean {
    try {
      return this.store().hasNonLegacyProfiles(provider);
    } catch {
      return false;
    }
  }

  noteUsed(provider: PooledProvider, profileId: string): void {
    this.lastUsedAt.set(this.lastUsedKey(provider, profileId), this.now());
  }

  getLastUsedAt(provider: PooledProvider): Map<string, number> {
    const result = new Map<string, number>();
    for (const [key, value] of this.lastUsedAt) {
      const [keyProvider, profileId] = key.split(':');
      if (keyProvider === provider && profileId) result.set(profileId, value);
    }
    return result;
  }

  async resolveRouteForSpawn(request: AccountRouteRequest): Promise<AccountRouteOutcome> {
    const preview = await this.preview(request);
    const outcome = preview.outcome;
    if (outcome.ok) {
      this.noteUsed(request.provider, outcome.route.profileId);
      emitProviderAccountEvent({
        event: 'account_route_resolved',
        provider: request.provider,
        profileId: outcome.route.profileId,
        routingSource: outcome.route.source,
        nodeId: outcome.route.executionNodeId,
        origin: request.origin,
        instanceId: request.instanceId,
      });
    } else {
      emitProviderAccountEvent({
        event: 'account_route_blocked',
        provider: request.provider,
        failureCode: outcome.code,
        profileId: outcome.profileId,
        origin: request.origin,
        instanceId: request.instanceId,
      });
    }
    return outcome;
  }

  /** The route a spawn would get, with the selector's reasoning. No side effects beyond binding checks. */
  async preview(request: AccountRouteRequest): Promise<AccountRoutePreview> {
    const nodeId = request.executionNodeId ?? LOCAL_ACCOUNT_NODE_ID;
    let profiles: ProviderAccountProfile[];
    try {
      profiles = this.store().listProfiles(request.provider);
    } catch (error) {
      logger.debug('No account store in this context; using the legacy route', {
        error: error instanceof Error ? error.message : String(error),
      });
      profiles = [];
    }

    const legacyOnly = !profiles.some((profile) => !profile.isLegacy);
    if (legacyOnly) {
      // Pre-pools behaviour, byte for byte: no sign-in check, no env change.
      return { outcome: { ok: true, route: this.buildRoute(request.provider, LEGACY_ACCOUNT_PROFILE_ID, 'legacy', nodeId, profiles) }, considered: [] };
    }

    if (request.persistedProfileId) {
      const persisted = profiles.find((profile) => profile.id === request.persistedProfileId);
      if (!persisted) {
        return {
          outcome: failure(
            'profile-missing',
            `This session ran on a ${pooledProviderLabel(request.provider)} account that has since been removed. Start a new session to continue on another account.`,
            request.persistedProfileId,
          ),
          considered: [],
        };
      }
      return { outcome: await this.admit(persisted, 'persisted', nodeId), considered: [] };
    }

    if (request.explicitProfileId) {
      const explicit = profiles.find((profile) => profile.id === request.explicitProfileId);
      if (!explicit) {
        return {
          outcome: failure('profile-missing', `No ${pooledProviderLabel(request.provider)} account "${request.explicitProfileId}".`, request.explicitProfileId),
          considered: [],
        };
      }
      if (!explicit.enabled) {
        return {
          outcome: failure('profile-disabled', `The ${explicit.label} account is disabled. Enable it in Settings → Accounts or pick another account.`, explicit.id),
          considered: [],
        };
      }
      if (explicit.automationPolicy === 'disabled'
        || (explicit.automationPolicy === 'manual-only' && isAutomaticAccountOrigin(request.origin))) {
        return {
          outcome: failure('automation-disallowed', `The ${explicit.label} account is not allowed for automatic work. Change its policy in Settings → Accounts.`, explicit.id),
          considered: [],
        };
      }
      return { outcome: await this.admit(explicit, 'explicit', nodeId), considered: [] };
    }

    return this.resolveDefault(request, profiles, nodeId);
  }

  private async resolveDefault(
    request: AccountRouteRequest,
    profiles: ProviderAccountProfile[],
    nodeId: string,
  ): Promise<AccountRoutePreview> {
    const model = request.model ?? null;
    const remote = nodeId !== LOCAL_ACCOUNT_NODE_ID;
    const bindings = new Map<string, AccountBindingState>();
    if (!remote) {
      await Promise.all(profiles.filter((profile) => profile.enabled).map(async (profile) => {
        const status = await this.bindings().checkBinding(profile, nodeId);
        bindings.set(profile.id, status.state);
      }));
    }
    const parked = this.readParked(request.provider, model);
    const quotaByProfile = new Map<string, AccountQuotaEvidence>();
    for (const profile of profiles) {
      const evidence = this.readQuota(request.provider, profile.id);
      if (evidence) quotaByProfile.set(profile.id, evidence);
    }
    let policyThreshold: number | null = null;
    try {
      const policy = this.store().getPoolPolicy(request.provider);
      policyThreshold = (request.newSession ?? true) && policy.preemptive.newSessions ? policy.preemptive.thresholdPct : null;
    } catch {
      policyThreshold = null;
    }

    const input = {
      profiles,
      origin: request.origin,
      exclude: request.exclude,
      parkedProfileIds: parked,
      bindings,
      ignoreBindings: remote,
      quotaByProfile,
      lastUsedAt: this.getLastUsedAt(request.provider),
      thresholdPct: policyThreshold,
    };
    let selection = selectAccount(input);
    if (selection.profileId === null && policyThreshold !== null) {
      // Every candidate is over the pre-emptive threshold: steering is a
      // preference, not a refusal, so pick without it.
      selection = selectAccount({ ...input, thresholdPct: null });
    }
    const source = request.defaultSource ?? 'default';
    if (selection.profileId !== null) {
      const chosen = profiles.find((profile) => profile.id === selection.profileId)!;
      return { outcome: { ok: true, route: this.buildRoute(request.provider, chosen.id, source, nodeId, profiles) }, considered: selection.considered };
    }

    // Nothing unparked: fall back to the existing behaviour (park until the
    // reset). Route to the signed-in profile whose limit lifts soonest; the
    // send-path gate holds the turn until then.
    const parkedButUsable = selectAccount({ ...input, parkedProfileIds: [], thresholdPct: null });
    if (parkedButUsable.profileId !== null && !request.exclude?.length) {
      const candidates = selection.considered
        .filter((entry) => entry.vetoReason === 'parked' || entry.vetoReason === 'exhausted')
        .map((entry) => entry.profileId);
      const soonest = this.pickSoonestReset(request.provider, model, candidates) ?? parkedButUsable.profileId;
      return { outcome: { ok: true, route: this.buildRoute(request.provider, soonest, source, nodeId, profiles) }, considered: selection.considered };
    }

    const reasons = new Set(selection.considered.map((entry) => entry.vetoReason));
    const label = pooledProviderLabel(request.provider);
    const outcome = reasons.has('parked') || reasons.has('exhausted')
      ? failure('all-profiles-parked', `Every ${label} account in the pool has hit its usage limit.`)
      : reasons.has('unbound')
        ? failure('profile-unauthenticated', `No enabled ${label} account is signed in. Verify or sign in to an account in Settings → Accounts.`)
        : reasons.has('automation-disallowed')
          ? failure('automation-disallowed', `No enabled ${label} account is allowed for this kind of work. Check account policies in Settings → Accounts.`)
          : failure('no-profiles', `No ${label} account is available. Enable an account in Settings → Accounts.`);
    return { outcome, considered: selection.considered };
  }

  private pickSoonestReset(provider: PooledProvider, model: string | null, profileIds: string[]): string | null {
    if (!this.deps.getSoonestResumeAt || profileIds.length === 0) return profileIds[0] ?? null;
    let best: { id: string; at: number } | null = null;
    for (const id of profileIds) {
      const at = this.deps.getSoonestResumeAt(provider, model, [id]);
      if (at !== null && (best === null || at < best.at)) best = { id, at };
    }
    return best?.id ?? profileIds[0] ?? null;
  }

  private readParked(provider: PooledProvider, model: string | null): string[] {
    try {
      return this.deps.getParkedProfileIds?.(provider, model) ?? [];
    } catch (error) {
      logger.warn('Could not read parked account profiles; treating none as parked', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private readQuota(provider: PooledProvider, profileId: string): AccountQuotaEvidence | null {
    try {
      return this.deps.getQuotaEvidence?.(provider, profileId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Node-local admission for a chosen profile. Refuses anything but a verified
   * sign-in. Never returns a different profile.
   */
  async admit(profile: ProviderAccountProfile, source: AccountRouteSource, nodeId: string = LOCAL_ACCOUNT_NODE_ID): Promise<AccountRouteOutcome> {
    const route = this.buildRoute(profile.provider, profile.id, source, nodeId, [profile]);
    if (nodeId !== LOCAL_ACCOUNT_NODE_ID) {
      // The worker verifies its own binding before it spawns (remote spawn RPC).
      return { ok: true, route };
    }
    const status = await this.bindings().checkBinding(profile, nodeId);
    switch (status.state) {
      case 'authenticated':
        return { ok: true, route };
      case 'unauthenticated':
        return failure('profile-unauthenticated', `The ${profile.label} account needs sign-in. Open Settings → Accounts and sign in again.`, profile.id);
      case 'identity-mismatch':
        return failure('profile-identity-mismatch', `The ${profile.label} account is signed in as a different identity than expected. Verify it in Settings → Accounts.`, profile.id);
      default:
        return failure('profile-not-bound-on-node', `The ${profile.label} account could not be verified on this machine (${status.errorCode ?? 'unavailable'}).`, profile.id);
    }
  }

  private buildRoute(
    provider: PooledProvider,
    profileId: string,
    source: AccountRouteSource,
    executionNodeId: string,
    profiles: readonly ProviderAccountProfile[],
  ): ResolvedAccountRoute {
    const profile = profiles.find((entry) => entry.id === profileId);
    return {
      provider,
      profileId,
      source,
      executionNodeId,
      ...(profile?.label ? { profileLabel: profile.label } : {}),
      ...(profile?.expectedIdentity ? { expectedIdentity: profile.expectedIdentity } : {}),
    };
  }
}

let instance: ProviderAccountRoutingService | null = null;
let unsubscribe: (() => void) | null = null;

export function getProviderAccountRoutingService(): ProviderAccountRoutingService {
  if (!instance) {
    instance = new ProviderAccountRoutingService({
      getParkedProfileIds: (provider, model) => getProviderLimitLedgerPort().getParkedProfileIds({ provider, model }),
      getSoonestResumeAt: (provider, model, profileIds) =>
        getProviderLimitLedgerPort().getSoonestResumeAt({ provider, model, profileIds }),
      getQuotaEvidence: (provider, profileId) => readAccountQuotaEvidence(provider, profileId),
    });
    unsubscribe = onProviderAccountsChanged(() => instance?.invalidate());
  }
  return instance;
}

export function _resetProviderAccountRoutingServiceForTesting(next?: ProviderAccountRoutingService): void {
  unsubscribe?.();
  unsubscribe = null;
  instance = next ?? null;
}
