/**
 * ProviderAccountRoutingService — the async front door to account pools.
 *
 * Resolves exactly one Claude or Codex account profile before a spawn
 * (spec §8.1):
 *
 *   1. a persisted profile wins (restore, respawn, native resume): changed pool
 *      settings never move a live thread. The one exception is a restart onto
 *      a persisted profile with a known active limit in an automatic pool:
 *      it would only be refused and switched on its first turn, so it lands
 *      on the failover target now;
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
  evidenceLiftsPark,
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
  /**
   * The only profiles that may be chosen (a session's account fence, e.g. the
   * accounts James allowed for the Plan Queue). Absent/empty = any profile.
   * A persisted profile still wins: a live thread never moves.
   */
  restrictTo?: readonly string[];
  /** Source to stamp when the default selection runs on behalf of failover. */
  defaultSource?: Extract<AccountRouteSource, 'default' | 'failover' | 'preemptive'>;
  /**
   * A restart of the session: a persisted profile with a known active limit
   * routes to the failover target (see `moveOffParkedPersisted`). Absent for
   * every other respawn, notably an account handoff onto a chosen profile.
   */
  moveOffLimitedAccount?: boolean;
  /** The spawn resumes the provider's own thread (false: a fresh provider session). */
  resume?: boolean;
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
  /** When each parked profile's newest limit was recorded (ledger); newer usage evidence lifts the park. */
  getParkedSince?: (provider: PooledProvider, model: string | null) => ReadonlyMap<string, number>;
  getSoonestResumeAt?: (provider: PooledProvider, model: string | null, profileIds: readonly string[]) => number | null;
  getQuotaEvidence?: (provider: PooledProvider, profileId: string) => AccountQuotaEvidence | null;
  /** Tell the user a restart moved the session off a limited account (the same notice a failover gives). */
  notify?: (input: { kind: string; instanceId: string; title: string; body: string }) => void;
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
      if (request.persistedProfileId && outcome.route.source === 'failover' && outcome.route.profileId !== request.persistedProfileId) {
        this.reportRestartMove(request, request.persistedProfileId, outcome.route.profileId);
      }
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

  /** A restart landed on another account: record it as the failover it is and tell the user. */
  private reportRestartMove(request: AccountRouteRequest, fromProfileId: string, toProfileId: string): void {
    emitProviderAccountEvent({
      event: 'account_failover_performed',
      provider: request.provider,
      profileId: toProfileId,
      fromProfileId,
      handoffKind: 'failover',
      instanceId: request.instanceId,
    });
    if (!request.instanceId || !this.deps.notify) return;
    let from = fromProfileId;
    let to = toProfileId;
    try {
      from = this.store().getProfile(request.provider, fromProfileId)?.label ?? from;
      to = this.store().getProfile(request.provider, toProfileId)?.label ?? to;
    } catch {
      // Labels are cosmetic; the profile ids still say which accounts.
    }
    try {
      this.deps.notify({
        kind: 'account-switched',
        instanceId: request.instanceId,
        title: 'Account switched',
        body: `${from} → ${to} (usage limit; restarted on the account with usage left).`,
      });
    } catch {
      // Notifications are best-effort.
    }
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
    if (legacyOnly && request.restrictTo?.length && !request.persistedProfileId && !request.restrictTo.includes(LEGACY_ACCOUNT_PROFILE_ID)) {
      return {
        outcome: failure('no-profiles', `None of the ${pooledProviderLabel(request.provider)} accounts this session is limited to exist any more. Start it again with accounts that exist.`),
        considered: [],
      };
    }
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
      const moved = request.moveOffLimitedAccount ? await this.moveOffParkedPersisted(request, persisted, profiles, nodeId) : null;
      if (moved) return moved;
      return { outcome: await this.admit(persisted, 'persisted', nodeId), considered: [] };
    }

    if (request.restrictTo?.length) {
      const allowed = new Set(request.restrictTo);
      profiles = profiles.filter((profile) => allowed.has(profile.id));
      if (profiles.length === 0) {
        return {
          outcome: failure('no-profiles', `None of the ${pooledProviderLabel(request.provider)} accounts this session is limited to exist any more. Start it again with accounts that exist.`),
          considered: [],
        };
      }
      if (request.explicitProfileId && !allowed.has(request.explicitProfileId)) {
        return {
          outcome: failure('automation-disallowed', `The "${request.explicitProfileId}" ${pooledProviderLabel(request.provider)} account is not one this session may use.`, request.explicitProfileId),
          considered: [],
        };
      }
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
    const parkedSince = parked.length > 0 ? this.readParkedSince(request.provider, model) : undefined;
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
      parkedSince,
      // Unattended work prefers accounts that do not bill purchased credits;
      // the fallback below still routes to one when nothing else is left.
      allowCredits: !isAutomaticAccountOrigin(request.origin),
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
    // send-path gate holds the turn until then. Usage evidence is ignored
    // here too: an account the provider reports as out of usage parks on its
    // first turn and resumes at its reset, rather than refusing the session.
    const parkedButUsable = selectAccount({ ...input, parkedProfileIds: [], quotaByProfile: undefined, thresholdPct: null });
    if (parkedButUsable.profileId !== null && !request.exclude?.length) {
      const candidates = selection.considered
        .filter((entry) => entry.vetoReason === 'parked' || entry.vetoReason === 'exhausted')
        .map((entry) => entry.profileId);
      const soonest = this.pickSoonestReset(request.provider, model, candidates) ?? parkedButUsable.profileId;
      return { outcome: { ok: true, route: this.buildRoute(request.provider, soonest, source, nodeId, profiles) }, considered: selection.considered };
    }

    const reasons = new Set(selection.considered.map((entry) => entry.vetoReason));
    const label = pooledProviderLabel(request.provider);
    const outcome = reasons.has('parked') || reasons.has('exhausted') || reasons.has('credits-only')
      ? failure('all-profiles-parked', `Every ${label} account in the pool has hit its usage limit.`)
      : reasons.has('unbound')
        ? failure('profile-unauthenticated', `No enabled ${label} account is signed in. Verify or sign in to an account in Settings → Accounts.`)
        : reasons.has('automation-disallowed')
          ? failure('automation-disallowed', `No enabled ${label} account is allowed for this kind of work. Check account policies in Settings → Accounts.`)
          : failure('no-profiles', `No ${label} account is available. Enable an account in Settings → Accounts.`);
    return { outcome, considered: selection.considered };
  }

  /**
   * A restart of a session whose account has a known active limit: in a pool that switches automatically and shares the
   * session store, resolve the failover target instead of re-spawning onto an
   * account that refuses every turn. Null keeps the persisted profile: no
   * limit, newer usage evidence lifted it, the pool asks first or is off, a
   * replay pool resuming its thread (the thread cannot move there; the first
   * refused turn's failover still moves it), or no other account is usable.
   * A fresh provider session (replay fallback, restart fresh) moves in any pool.
   */
  private async moveOffParkedPersisted(
    request: AccountRouteRequest,
    persisted: ProviderAccountProfile,
    profiles: ProviderAccountProfile[],
    nodeId: string,
  ): Promise<AccountRoutePreview | null> {
    let policy;
    try {
      policy = this.store().getPoolPolicy(request.provider);
    } catch {
      return null;
    }
    if (policy.failoverMode !== 'automatic' || policy.acknowledgedOwnershipAt === null) return null;
    if (policy.continuation !== 'shared-store' && request.resume !== false) return null;
    const model = request.model ?? null;
    if (!this.readParked(request.provider, model).includes(persisted.id)) return null;
    const parkedSince = this.readParkedSince(request.provider, model)?.get(persisted.id);
    if (evidenceLiftsPark(this.readQuota(request.provider, persisted.id), parkedSince, { allowCredits: true })) return null;

    const fence = request.restrictTo?.length ? new Set(request.restrictTo) : null;
    const candidates = fence ? profiles.filter((profile) => fence.has(profile.id)) : profiles;
    const preview = await this.resolveDefault({
      ...request,
      persistedProfileId: undefined,
      moveOffLimitedAccount: undefined,
      newSession: false,
      exclude: [...(request.exclude ?? []), persisted.id],
      defaultSource: 'failover',
    }, candidates, nodeId);
    if (!preview.outcome.ok) return null;
    logger.info('Restarting a session on another account: its own account has a known usage limit', {
      instanceId: request.instanceId,
      provider: request.provider,
      fromProfileId: persisted.id,
      toProfileId: preview.outcome.route.profileId,
    });
    return preview;
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

  private readParkedSince(provider: PooledProvider, model: string | null): ReadonlyMap<string, number> | undefined {
    try {
      return this.deps.getParkedSince?.(provider, model);
    } catch {
      return undefined;
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
  async admit(
    profile: ProviderAccountProfile,
    source: AccountRouteSource,
    nodeId: string = LOCAL_ACCOUNT_NODE_ID,
    bindingOptions: { force?: boolean } = {},
  ): Promise<AccountRouteOutcome> {
    const route = this.buildRoute(profile.provider, profile.id, source, nodeId, [profile]);
    if (nodeId !== LOCAL_ACCOUNT_NODE_ID) {
      // The worker verifies its own binding before it spawns (remote spawn RPC).
      return { ok: true, route };
    }
    const status = await this.bindings().checkBinding(profile, nodeId, bindingOptions);
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
      // OpenCode/MiMo: the executing node derives the provider name and reads
      // the region's model metadata from its own `opencode` (never a path/key).
      ...(profile?.region ? { region: profile.region } : {}),
    };
  }
}

let instance: ProviderAccountRoutingService | null = null;
let unsubscribe: (() => void) | null = null;

export function getProviderAccountRoutingService(): ProviderAccountRoutingService {
  if (!instance) {
    instance = new ProviderAccountRoutingService({
      getParkedProfileIds: (provider, model) => getProviderLimitLedgerPort().getParkedProfileIds({ provider, model }),
      getParkedSince: (provider, model) => getProviderLimitLedgerPort().getParkedSince({ provider, model }),
      getSoonestResumeAt: (provider, model, profileIds) =>
        getProviderLimitLedgerPort().getSoonestResumeAt({ provider, model, profileIds }),
      getQuotaEvidence: (provider, profileId) => readAccountQuotaEvidence(provider, profileId),
      // Loaded on use: the notification service pulls in Electron, which this module otherwise avoids.
      notify: (input) => {
        void import('../../notifications/notification-service')
          .then(({ getNotificationService }) => getNotificationService().notify({ ...input, urgency: 'normal' }))
          .catch((error: unknown) => logger.debug('Could not show the account-switch notice', {
            error: error instanceof Error ? error.message : String(error),
          }));
      },
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
