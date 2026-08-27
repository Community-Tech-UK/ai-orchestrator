/**
 * CopilotAccountRoutingService — the async front door to Copilot routing.
 *
 * Gathers evidence (settings, git remotes, canonical paths), delegates the
 * decision to the pure resolver, then runs the admission checks that need I/O:
 *
 *   profile exists → bound on this node → authenticated → identity verified
 *   → automation policy permits this origin
 *
 * Identity verification is mandatory before every spawn, not a stale-cache
 * refresh. Copilot's keychain entries are keyed by `${host}:${login}`, not by
 * `COPILOT_HOME`, and its `getAnyToken()` fallback will happily return some
 * other stored account's token — so a profile home whose `lastLoggedInUser` is
 * missing or wrong can authenticate as the wrong identity. That is the failure
 * this whole feature exists to prevent, so it fails closed here.
 *
 * No failure path ever returns a different profile.
 */

import type {
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
  CopilotInvocationOrigin,
  CopilotRouteOutcome,
} from '../../../shared/types/copilot-account.types';
import {
  COPILOT_LEGACY_PROFILE_ID,
  normalizeCopilotHost,
} from '../../../shared/types/copilot-account.types';
import type { AppSettings } from '../../../shared/types/settings.types';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import { canonicalizeWorkspacePath } from '../../security/canonical-workspace-path';
import {
  collectFetchRemoteIdentities,
  type GitHubRemoteIdentity,
} from '../../vcs/remotes/github-remote-identity';
import { isProviderExcludedFromAutomation } from '../automation-provider-exclusions';
import {
  CopilotAccountBindingService,
  LOCAL_COPILOT_NODE_ID,
  getCopilotAccountBindingService,
} from './copilot-account-binding-service';
import {
  resolveContextFreeCopilotRoute,
  resolveCopilotAccountRoute,
} from './copilot-account-resolver';
import { emitCopilotAccountEvent } from './copilot-account-events';
import { isAutomaticCopilotOrigin } from '../../../shared/types/copilot-account.types';

const logger = getLogger('CopilotAccountRouting');

/** Route cache TTL. Long enough to spare repeated git calls in a fan-out, short
 *  enough that a settings change is never stale for long — and every mutation
 *  path calls `invalidate()` anyway. */
const ROUTE_CACHE_TTL_MS = 15_000;

export interface CopilotRouteRequest {
  workingDirectory?: string;
  explicitProfileId?: string;
  confirmProtectedOverride?: boolean;
  persistedProfileId?: string;
  origin: CopilotInvocationOrigin;
  /** Defaults to the local controller node. */
  executionNodeId?: string;
  /** Correlation only; never used for routing. */
  instanceId?: string;
}

interface RoutingSettings {
  profiles: CopilotAccountProfile[];
  rules: CopilotAccountRoutingRule[];
  /** Bumped whenever either settings key changes; part of the cache key. */
  version: string;
}

interface CacheEntry {
  outcome: CopilotRouteOutcome;
  cachedAt: number;
}

export interface CopilotAccountRoutingDeps {
  readSettings?: () => Pick<
    AppSettings,
    'copilotAccountProfiles' | 'copilotAccountRoutingRules'
  >;
  bindingService?: CopilotAccountBindingService;
  collectRemotes?: (cwd: string, knownHosts: readonly string[]) => GitHubRemoteIdentity[];
  canonicalize?: (path: string) => string;
  isProviderExcluded?: (provider: string) => boolean;
  now?: () => number;
}

export class CopilotAccountRoutingService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: CopilotAccountRoutingDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private bindings(): CopilotAccountBindingService {
    return this.deps.bindingService ?? getCopilotAccountBindingService();
  }

  private canonicalize(path: string): string {
    return (this.deps.canonicalize ?? canonicalizeWorkspacePath)(path);
  }

  private readRoutingSettings(): RoutingSettings {
    const read =
      this.deps.readSettings ?? (() => getSettingsManager().getAll());
    const settings = read();
    // Normalize on READ, not just on write. The installed CLI records
    // `lastLoggedInUser.host` with a scheme ("https://github.com"), and the
    // first migration persisted that verbatim — while git remotes parse to a
    // bare hostname. An un-normalized profile host silently matches NO remote,
    // so every routing rule quietly stops firing. Repairing here means records
    // written before the fix heal themselves without a second migration.
    const profiles = (Array.isArray(settings.copilotAccountProfiles)
      ? settings.copilotAccountProfiles
      : []
    ).map((profile) => {
      const host = normalizeCopilotHost(profile.host);
      return host === profile.host ? profile : { ...profile, host };
    });
    const rules = Array.isArray(settings.copilotAccountRoutingRules)
      ? settings.copilotAccountRoutingRules
      : [];
    // Version derived from the content itself: the settings manager has no
    // per-key revision counter, and a content hash means an out-of-band edit
    // cannot leave a stale route cached.
    const version = `${profiles.length}:${rules.length}:${profiles
      .map((profile) => `${profile.id}/${profile.updatedAt}/${profile.isDefault ? 1 : 0}`)
      .join(',')}|${rules.map((rule) => `${rule.id}/${rule.updatedAt}`).join(',')}`;
    return { profiles, rules, version };
  }

  /** Drop cached routes. Called on settings change, login launch, and identity
   *  mismatch (spec §18). */
  invalidate(): void {
    this.cache.clear();
  }

  /** True once the operator has any Copilot account profile configured. */
  hasProfiles(): boolean {
    try {
      return this.readRoutingSettings().profiles.length > 0;
    } catch {
      return false;
    }
  }

  listProfiles(): CopilotAccountProfile[] {
    try {
      return this.readRoutingSettings().profiles;
    } catch {
      return [];
    }
  }

  async resolveRouteForSpawn(request: CopilotRouteRequest): Promise<CopilotRouteOutcome> {
    const nodeId = request.executionNodeId ?? LOCAL_COPILOT_NODE_ID;
    let settings: RoutingSettings;
    try {
      settings = this.readRoutingSettings();
    } catch (error) {
      logger.warn('Could not read Copilot account settings', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        code: 'no-profiles',
        detail:
          'Copilot account settings could not be read, so no account can be resolved. Reopen Settings › GitHub Copilot Accounts.',
      };
    }

    // The coarse operator override wins outright and is evaluated BEFORE any
    // per-profile policy: when `copilot` is on the exclusion list, no Copilot
    // account may be selected automatically at all.
    const excluded = (this.deps.isProviderExcluded ?? isProviderExcludedFromAutomation)('copilot');
    if (excluded && isAutomaticCopilotOrigin(request.origin)) {
      const outcome: CopilotRouteOutcome = {
        ok: false,
        code: 'automation-disallowed',
        detail:
          'GitHub Copilot is on the "never auto-pick these providers" list, so no Copilot account can be selected automatically. Start the session yourself, or remove Copilot from that list in Settings.',
      };
      this.report(outcome, request, nodeId);
      return outcome;
    }

    // No profiles configured at all — the legacy migration has not run yet (or
    // its settings write failed). Synthesize the implicit legacy route so a
    // single-account install behaves EXACTLY as it did before this feature:
    // one Copilot home, whatever account is signed into it.
    //
    // This is not a bypass. Every protection this feature adds — protected
    // scopes, matched-only profiles, ambiguity detection, per-profile
    // automation policy — is expressed in terms of configured profiles and
    // rules. With none configured there is no second account to leak to, and
    // profile/rule mutation is operator-only, so an agent cannot reach this
    // state by clearing settings. Admission checks are skipped for the same
    // reason: gating on a binding AIO never asked the user to establish would
    // break working installs at upgrade time.
    if (settings.profiles.length === 0) {
      const outcome: CopilotRouteOutcome = {
        ok: true,
        route: {
          profileId: COPILOT_LEGACY_PROFILE_ID,
          source: 'legacy',
          executionNodeId: nodeId,
          profileLabel: 'Existing Copilot account',
          expectedLogin: null,
        },
      };
      this.report(outcome, request, nodeId);
      return outcome;
    }

    const cacheKey = this.cacheKey(request, nodeId, settings.version);
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.cachedAt < ROUTE_CACHE_TTL_MS) {
      // Binding state is re-verified below even on a cache hit — only the
      // *decision* is cached, never the admission result.
      if (cached.outcome.ok) {
        const admitted = await this.admit(cached.outcome, settings.profiles, nodeId);
        this.report(admitted, request, nodeId);
        return admitted;
      }
      this.report(cached.outcome, request, nodeId);
      return cached.outcome;
    }

    const decided = this.decide(request, settings, nodeId);
    this.cache.set(cacheKey, { outcome: decided, cachedAt: this.now() });
    const admitted = decided.ok
      ? await this.admit(decided, settings.profiles, nodeId)
      : decided;
    this.report(admitted, request, nodeId);
    return admitted;
  }

  private cacheKey(
    request: CopilotRouteRequest,
    nodeId: string,
    settingsVersion: string,
  ): string {
    const workspace = request.workingDirectory
      ? this.canonicalize(request.workingDirectory)
      : '';
    return [
      nodeId,
      settingsVersion,
      workspace,
      request.explicitProfileId ?? '',
      request.persistedProfileId ?? '',
      request.confirmProtectedOverride ? '1' : '0',
      request.origin,
    ].join(' ');
  }

  /** Evidence gathering plus the pure resolver. No I/O beyond git/fs reads. */
  private decide(
    request: CopilotRouteRequest,
    settings: RoutingSettings,
    nodeId: string,
  ): CopilotRouteOutcome {
    const knownHosts = [...new Set(settings.profiles.map((profile) => profile.host))];

    if (!request.workingDirectory) {
      return resolveContextFreeCopilotRoute({
        profiles: settings.profiles,
        rules: settings.rules,
        explicitProfileId: request.explicitProfileId,
        confirmProtectedOverride: request.confirmProtectedOverride,
        persistedProfileId: request.persistedProfileId,
        origin: request.origin,
        executionNodeId: nodeId,
      });
    }

    const canonicalWorkspacePath = this.canonicalize(request.workingDirectory);
    const collect = this.deps.collectRemotes ?? collectFetchRemoteIdentities;
    const remotes = collect(request.workingDirectory, knownHosts);
    const canonicalRulePaths: Record<string, string> = {};
    for (const rule of settings.rules) {
      if (rule.matcher.type === 'path-prefix') {
        canonicalRulePaths[rule.id] = this.canonicalize(rule.matcher.canonicalPath);
      }
    }

    return resolveCopilotAccountRoute({
      profiles: settings.profiles,
      rules: settings.rules,
      canonicalWorkspacePath,
      remotes,
      explicitProfileId: request.explicitProfileId,
      confirmProtectedOverride: request.confirmProtectedOverride,
      persistedProfileId: request.persistedProfileId,
      origin: request.origin,
      executionNodeId: nodeId,
      canonicalRulePaths,
    });
  }

  /**
   * Mandatory pre-spawn admission. Runs on every call, cached decision or not.
   */
  private async admit(
    outcome: Extract<CopilotRouteOutcome, { ok: true }>,
    profiles: CopilotAccountProfile[],
    nodeId: string,
  ): Promise<CopilotRouteOutcome> {
    const profile = profiles.find((candidate) => candidate.id === outcome.route.profileId);
    if (!profile) {
      return {
        ok: false,
        code: 'profile-missing',
        detail: 'The resolved Copilot account no longer exists. Re-add it, or choose another account.',
        profileId: outcome.route.profileId,
      };
    }

    // Node binding is derived from the profile's own Copilot state on the node
    // that will run it. A remote node reports its own; the local controller
    // reads the local profile home.
    if (nodeId !== LOCAL_COPILOT_NODE_ID) {
      // The worker verifies its own binding before spawning (Phase 8). The
      // controller cannot read another machine's Copilot home, and must not
      // pretend to: the route carries the expected identity for the worker to
      // check, and a worker without the binding returns a typed failure.
      return { ok: true, route: outcome.route };
    }

    const binding = await this.bindings().checkBinding(profile, nodeId);
    emitCopilotAccountEvent({
      event: 'copilot_account_binding_checked',
      profileId: profile.id,
      nodeId,
      state: binding.state,
    });

    switch (binding.state) {
      case 'authenticated':
        return { ok: true, route: outcome.route };
      case 'unauthenticated':
        return {
          ok: false,
          code: 'profile-unauthenticated',
          detail: `Copilot account "${profile.label}" is not signed in on this device. Sign in for this profile from Settings › GitHub Copilot Accounts.`,
          profileId: profile.id,
        };
      case 'identity-mismatch':
        // Fails closed even though a valid token exists for some other account
        // — that is exactly the case the check is for.
        this.bindings().invalidate(profile.id, nodeId);
        emitCopilotAccountEvent({
          event: 'copilot_account_identity_mismatch',
          profileId: profile.id,
          nodeId,
          observedLogin: binding.observedLogin,
          observedHost: binding.observedHost,
        });
        return {
          ok: false,
          code: 'profile-identity-mismatch',
          detail: `Copilot account "${profile.label}" is signed in as a different GitHub identity than expected. Reauthenticate this profile, or explicitly adopt the observed account.`,
          profileId: profile.id,
        };
      default:
        return {
          ok: false,
          code: 'profile-not-bound-on-node',
          detail: `Copilot account "${profile.label}" could not be verified on this device (${binding.errorCode ?? 'unavailable'}). Sign in for this profile, or check its state directory.`,
          profileId: profile.id,
        };
    }
  }

  private report(
    outcome: CopilotRouteOutcome,
    request: CopilotRouteRequest,
    nodeId: string,
  ): void {
    if (outcome.ok) {
      emitCopilotAccountEvent({
        event: 'copilot_account_route_resolved',
        profileId: outcome.route.profileId,
        routingSource: outcome.route.source,
        ruleId: outcome.route.ruleId,
        origin: request.origin,
        nodeId,
        instanceId: request.instanceId,
      });
      return;
    }
    emitCopilotAccountEvent({
      event: 'copilot_account_route_blocked',
      failureCode: outcome.code,
      profileId: outcome.profileId,
      origin: request.origin,
      nodeId,
      instanceId: request.instanceId,
    });
  }
}

let instance: CopilotAccountRoutingService | null = null;

export function getCopilotAccountRoutingService(): CopilotAccountRoutingService {
  if (!instance) {
    instance = new CopilotAccountRoutingService();
  }
  return instance;
}

export function _resetCopilotAccountRoutingForTesting(): void {
  instance = null;
}
