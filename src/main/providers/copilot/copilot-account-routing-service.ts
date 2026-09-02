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
  CopilotAccountKind,
  CopilotAutomationPolicy,
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
  CopilotInvocationOrigin,
  CopilotRouteOutcome,
} from '../../../shared/types/copilot-account.types';
import {
  COPILOT_LEGACY_PROFILE_ID,
  normalizeCopilotProfileHost,
  normalizeCopilotRuleHost,
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
  collectProtectedScopeProfileIds,
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

/**
 * Result of {@link CopilotAccountRoutingService.classifyWorkspaceScope}.
 *
 * `ambiguous` and `indeterminate` are both fail-closed signals: the caller
 * knows a licence boundary might apply but cannot say which, so it must not
 * proceed as though the workspace were unscoped.
 */
export type WorkspaceCopilotScope =
  | { kind: 'none' }
  | {
      kind: 'protected';
      profileId: string;
      profileLabel: string;
      accountKind: CopilotAccountKind;
      /**
       * The profile's own automation policy. Carried because the ping-pong
       * reviewer spawns through `InstanceManager.createInstance`, which tags
       * every route request `'interactive'` — so `checkAutomationPolicy`'s
       * `manual-only` branch (gated on an AUTOMATIC origin) never fires there.
       * The checking policy must enforce it itself rather than assume the
       * router will.
       */
      automationPolicy: CopilotAutomationPolicy;
    }
  | { kind: 'ambiguous'; profileIds: string[] }
  | { kind: 'indeterminate'; reason: string };

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
  private readonly scopeCache = new Map<string, { scope: WorkspaceCopilotScope; cachedAt: number }>();
  /** Last authoritative scope per workspace; survives a later read failure. */
  private readonly lastKnownScope = new Map<string, WorkspaceCopilotScope>();
  /** Has this install EVER had a protected rule pointing at an enterprise seat? */
  private sawEnterpriseProtectedRule = false;
  /**
   * Has a settings read EVER succeeded on this instance? Distinct from the flag
   * above, and the distinction is load-bearing: "no enterprise rule" is only
   * meaningful once we have actually managed to look.
   */
  private everReadSettings = false;

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

  /**
   * Distinguishes "there is no settings manager in this context" from "the
   * settings manager exists but the read failed".
   *
   * The difference is load-bearing for licence containment. If `getSettingsManager()`
   * itself throws there is no Electron userData in this process at all — the
   * `aio review` CLI and the test runner are the real cases — which means Copilot
   * account routing CANNOT be configured here, so there is no licence boundary to
   * protect and checking must stay enabled. If the manager exists but `.getAll()`
   * throws (the settings lock times out after 5s under concurrent writes), a
   * licence boundary may well exist and we must not assume it away.
   */
  private readRoutingSettingsOrFailure():
    | { ok: true; settings: RoutingSettings }
    | { ok: false; kind: 'manager-unavailable' | 'read-failed'; detail: string } {
    const toDetail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    if (this.deps.readSettings) {
      try {
        return { ok: true, settings: this.normalizeRoutingSettings(this.deps.readSettings()) };
      } catch (error) {
        return { ok: false, kind: 'read-failed', detail: toDetail(error) };
      }
    }

    let manager: ReturnType<typeof getSettingsManager>;
    try {
      manager = getSettingsManager();
    } catch (error) {
      return { ok: false, kind: 'manager-unavailable', detail: toDetail(error) };
    }
    try {
      return { ok: true, settings: this.normalizeRoutingSettings(manager.getAll()) };
    } catch (error) {
      return { ok: false, kind: 'read-failed', detail: toDetail(error) };
    }
  }

  private readRoutingSettings(): RoutingSettings {
    const read =
      this.deps.readSettings ?? (() => getSettingsManager().getAll());
    return this.normalizeRoutingSettings(read());
  }

  private normalizeRoutingSettings(
    settings: Pick<AppSettings, 'copilotAccountProfiles' | 'copilotAccountRoutingRules'>,
  ): RoutingSettings {
    // Normalize on READ, not just on write. The installed CLI records
    // `lastLoggedInUser.host` with a scheme ("https://github.com"), and the
    // first migration persisted that verbatim — while git remotes parse to a
    // bare hostname. An un-normalized profile host silently matches NO remote,
    // so every routing rule quietly stops firing. Repairing here means records
    // written before the fix heal themselves without a second migration.
    const profiles = (Array.isArray(settings.copilotAccountProfiles)
      ? settings.copilotAccountProfiles
      : []
    ).map(normalizeCopilotProfileHost);
    // Rules need the SAME repair, and for a sharper reason: `matchesRepository`
    // / `matchesOwner` compare `matcher.host` against a git remote host, which
    // is always parsed bare. A scheme-prefixed matcher therefore matches
    // nothing — and when that matcher belongs to a PROTECTED rule, the
    // workspace silently falls through to the default account instead of
    // failing closed, which inverts the guarantee this feature exists to give.
    const rules = (Array.isArray(settings.copilotAccountRoutingRules)
      ? settings.copilotAccountRoutingRules
      : []
    ).map(normalizeCopilotRuleHost);
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
    this.scopeCache.clear();
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

  /**
   * Whose *protected* scope does this workspace sit in?
   *
   * Used by the cross-model checking policy to keep employer code on the
   * employer's licence: work in a protected enterprise scope is checked on that
   * same seat, never handed to another vendor's CLI.
   *
   * Deliberately NOT `resolveRouteForSpawn`. That answers "may we spawn Copilot
   * here" and would report no scope at all when the seat is excluded from
   * automation, signed out or `manual-only` — none of which stop the code being
   * the employer's. This runs matching only: no precedence, no scope policy, no
   * automation policy, no admission, no auth. It is cheap enough to call per
   * review dispatch.
   *
   * When settings cannot be read, the answer degrades in this order: the last
   * scope successfully computed for this workspace, else `none` if this machine
   * has never had a protected enterprise rule, else `indeterminate` (which
   * callers must fail closed on). The middle rung matters: an install with no
   * enterprise scope has no licence boundary to protect, so a transient settings
   * error there must not disable checking for every provider everywhere — the
   * settings lock can genuinely time out under concurrent writes.
   */
  classifyWorkspaceScope(workingDirectory: string | undefined): WorkspaceCopilotScope {
    if (!workingDirectory) return { kind: 'none' };

    // Classification runs git remote collection, and the checking policy asks
    // for it once per review dispatch — several times per loop round. Same TTL
    // as the route cache, and `invalidate()` clears both.
    const memoized = this.scopeCache.get(workingDirectory);
    if (memoized && this.now() - memoized.cachedAt < ROUTE_CACHE_TTL_MS) {
      return memoized.scope;
    }
    const scope = this.computeWorkspaceScope(workingDirectory);
    // Never memoize a non-authoritative answer: an unreadable settings file must
    // not pin a degraded verdict for the whole TTL.
    if (scope.kind !== 'indeterminate') {
      this.scopeCache.set(workingDirectory, { scope, cachedAt: this.now() });
      this.lastKnownScope.set(workingDirectory, scope);
    }
    return scope;
  }

  /**
   * Best answer available when the evidence cannot be gathered right now.
   * See the ordering rationale on {@link classifyWorkspaceScope}.
   */
  private degradedScope(workingDirectory: string, reason: string): WorkspaceCopilotScope {
    const lastKnown = this.lastKnownScope.get(workingDirectory);
    if (lastKnown) return lastKnown;
    // Only claim "no licence boundary" once we have actually managed to read the
    // settings at least once. If the FIRST read of the process fails, an absent
    // enterprise rule is ignorance, not evidence — reporting `none` there would
    // let one dispatch check employer code off its own seat.
    if (this.everReadSettings && !this.sawEnterpriseProtectedRule) return { kind: 'none' };
    return { kind: 'indeterminate', reason };
  }

  /**
   * The one narrow exception to the coarse `providersExcludedFromAutomation`
   * guard.
   *
   * That guard exists because a Copilot seat's licence can be scoped to an
   * employer's repositories, so the app must never *pick* Copilot out of a pool
   * on the user's behalf. Checking work that already lives inside a protected
   * enterprise scope is not that case: the workspace MANDATES that account, and
   * the alternative — reviewing employer code on the Claude CLI, the Codex CLI
   * or a personal seat — is the very outcome the guard is meant to prevent.
   *
   * Deliberately limited to the checking origins. Scaffolding, magic prompts,
   * loops, workflows, failover and generic automation keep the coarse guard, so
   * this cannot become a general "Copilot is back on" switch.
   */
  private isLicenceMandated(request: CopilotRouteRequest): boolean {
    if (request.origin !== 'review' && request.origin !== 'verification' && request.origin !== 'consensus') {
      return false;
    }
    const scope = this.classifyWorkspaceScope(request.workingDirectory);
    return scope.kind === 'protected' && scope.accountKind === 'enterprise';
  }

  private hasEnterpriseProtectedRule(settings: RoutingSettings): boolean {
    return settings.rules.some(
      (rule) =>
        rule.isProtected &&
        settings.profiles.find((profile) => profile.id === rule.profileId)?.accountKind ===
          'enterprise',
    );
  }

  /** Is any protected ENTERPRISE rule matched by git remote rather than by path? */
  private hasRemoteScopedEnterpriseRule(settings: RoutingSettings): boolean {
    return settings.rules.some(
      (rule) =>
        rule.isProtected &&
        rule.matcher.type !== 'path-prefix' &&
        settings.profiles.find((profile) => profile.id === rule.profileId)?.accountKind ===
          'enterprise',
    );
  }

  private computeWorkspaceScope(workingDirectory: string): WorkspaceCopilotScope {
    const read = this.readRoutingSettingsOrFailure();
    if (!read.ok) {
      if (read.kind === 'manager-unavailable') {
        // No settings manager in this process, so no Copilot account routing can
        // be configured here and there is no licence boundary to protect.
        logger.debug('No settings manager available; treating workspace as unscoped', {
          error: read.detail,
        });
        return { kind: 'none' };
      }
      logger.warn('Could not read Copilot settings to classify workspace scope', {
        error: read.detail,
      });
      return this.degradedScope(workingDirectory, 'copilot-settings-unreadable');
    }
    const settings = read.settings;

    // Remembered across later read failures so the degraded path knows both that
    // we have successfully looked, and whether this machine has a licence
    // boundary worth failing closed for.
    this.everReadSettings = true;
    if (!this.sawEnterpriseProtectedRule && this.hasEnterpriseProtectedRule(settings)) {
      this.sawEnterpriseProtectedRule = true;
    }

    if (settings.rules.length === 0) return { kind: 'none' };

    const canonicalWorkspacePath = this.canonicalize(workingDirectory);
    const canonicalRulePaths: Record<string, string> = {};
    for (const rule of settings.rules) {
      if (rule.matcher.type === 'path-prefix') {
        canonicalRulePaths[rule.id] = this.canonicalize(rule.matcher.canonicalPath);
      }
    }

    // Git evidence is OPTIONAL. Reviewing a non-git folder, or a transient git
    // failure, must not disable checking — but it does matter when an enterprise
    // scope is defined by a repository/owner rule, because then missing remotes
    // could hide a real licence boundary. So fail closed only in that case; with
    // path-prefix enterprise rules the remotes are irrelevant to the answer.
    let remotes: GitHubRemoteIdentity[] = [];
    try {
      const knownHosts = [...new Set(settings.profiles.map((profile) => profile.host))];
      const collect = this.deps.collectRemotes ?? collectFetchRemoteIdentities;
      remotes = collect(workingDirectory, knownHosts);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (this.hasRemoteScopedEnterpriseRule(settings)) {
        logger.warn('Could not read git remotes and a remote-scoped enterprise rule exists', {
          error: detail,
        });
        return this.degradedScope(workingDirectory, 'git-remotes-unavailable');
      }
      logger.debug('No git remotes available; continuing with path-prefix matching only', {
        error: detail,
      });
    }

    const claimants = collectProtectedScopeProfileIds({
      rules: settings.rules,
      remotes,
      canonicalWorkspacePath,
      canonicalRulePaths,
    });

    if (claimants.length === 0) return { kind: 'none' };
    if (claimants.length > 1) return { kind: 'ambiguous', profileIds: claimants };

    const profileId = claimants[0] as string;
    const profile = settings.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      // A protected rule pointing at a deleted profile is exactly the case that
      // must not silently downgrade to "unprotected".
      return { kind: 'ambiguous', profileIds: claimants };
    }

    return {
      kind: 'protected',
      profileId: profile.id,
      profileLabel: profile.label,
      accountKind: profile.accountKind,
      automationPolicy: profile.automationPolicy,
    };
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
    if (excluded && isAutomaticCopilotOrigin(request.origin) && !this.isLicenceMandated(request)) {
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
    ].join('\x00');
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
