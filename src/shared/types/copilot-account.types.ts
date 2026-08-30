/**
 * GitHub Copilot account routing — shared domain types.
 *
 * A Copilot *account profile* is a named, isolated Copilot CLI state directory
 * bound to exactly one GitHub identity. AIO routes every Copilot invocation to
 * exactly one profile, resolved from the workspace before the child process
 * starts. See docs/superpowers/specs/2026-08-25-copilot-account-routing_spec.
 *
 * These types are deliberately secret-free: a profile carries an identity
 * *label*, never a token, keychain reference, or absolute home directory. The
 * home path is derived on the execution node from the validated profile ID
 * (see `copilot-account-home-resolver.ts`).
 */

/** Whether a profile may service workspaces that matched no routing rule. */
export type CopilotAccountScopePolicy = 'matched-only' | 'default-eligible';

/** Whether a profile may be selected by paths that pick a provider automatically. */
export type CopilotAutomationPolicy = 'allow-routed' | 'manual-only' | 'disabled';

/** Broad account category. Supplies safe defaults and UI language only — it is
 *  never itself a routing signal. */
export type CopilotAccountKind = 'personal' | 'enterprise';

export interface CopilotAccountProfile {
  /** Immutable safe slug. Becomes a directory name, so it is strictly validated. */
  id: string;
  /** User-facing label, e.g. "Enterprise". */
  label: string;
  /** Verified GitHub login, populated after the first verified login. */
  expectedLogin: string | null;
  /** Normalized host, normally `github.com`. */
  host: string;
  accountKind: CopilotAccountKind;
  scopePolicy: CopilotAccountScopePolicy;
  automationPolicy: CopilotAutomationPolicy;
  isDefault: boolean;
  /** True for the migration-created profile bound to the pre-existing
   *  `copilot-cli-home` directory (or the `AI_ORCHESTRATOR_COPILOT_HOME`
   *  override). Its home is the legacy path, not a `copilot-cli-profiles/` child. */
  isLegacy?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CopilotRoutingMatcher =
  | { type: 'repository'; host: string; owner: string; repo: string }
  | { type: 'owner'; host: string; owner: string }
  | { type: 'path-prefix'; canonicalPath: string };

export interface CopilotAccountRoutingRule {
  id: string;
  profileId: string;
  matcher: CopilotRoutingMatcher;
  /**
   * A failed or ambiguous match inside this scope blocks Copilot rather than
   * falling through to another account. Named `isProtected` rather than
   * `protected` because `protected` is a reserved word in strict-mode TS
   * class contexts and reads poorly through object spreads.
   */
  isProtected: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CopilotAccountBindingState =
  | 'authenticated'
  | 'unauthenticated'
  | 'identity-mismatch'
  | 'unavailable';

/**
 * Node-local authentication health for one profile. Derived from that profile's
 * own Copilot config on the node that will run it — never copied into AIO's
 * database and never carrying token material.
 */
export interface CopilotAccountBindingStatus {
  profileId: string;
  /** The canonical local-node identity on the controller. */
  nodeId: string;
  state: CopilotAccountBindingState;
  observedLogin?: string;
  observedHost?: string;
  checkedAt: number;
  errorCode?: string;
  /** True when the profile's own settings opt into plaintext token storage.
   *  Surfaced by Doctor as a warning; never accompanied by the token itself. */
  storesTokenPlaintext?: boolean;
}

export type CopilotRouteSource =
  | 'explicit'
  | 'repository'
  | 'owner'
  | 'path-prefix'
  | 'default'
  | 'legacy'
  | 'persisted';

/**
 * Safe routing metadata attached to a spawn. Contains no filesystem path and no
 * credential material, so it is safe to put on `UnifiedSpawnOptions`, persist on
 * a session, log, and send over remote-node RPC.
 */
export interface ResolvedCopilotAccountRoute {
  profileId: string;
  source: CopilotRouteSource;
  ruleId?: string;
  repository?: { host: string; owner: string; repo: string };
  executionNodeId: string;
  /** Display label of the resolved profile, for UI provenance. */
  profileLabel?: string;
  /** Verified GitHub login the worker must confirm before spawning. */
  expectedLogin?: string | null;
  /** Normalized host for the resolved profile. */
  host?: string;
}

export type CopilotRouteFailureCode =
  | 'no-profiles'
  | 'no-match'
  | 'ambiguous-remotes'
  | 'ambiguous-rules'
  | 'protected-scope-unmapped'
  | 'profile-missing'
  | 'profile-not-bound-on-node'
  | 'profile-unauthenticated'
  | 'profile-identity-mismatch'
  | 'automation-disallowed'
  | 'unrouted-launch-shape';

/**
 * Where a Copilot invocation came from. Automatic origins are policed by each
 * profile's `automationPolicy`; `interactive` is a deliberate human choice.
 */
export type CopilotInvocationOrigin =
  | 'interactive'
  | 'automation'
  | 'review'
  | 'verification'
  | 'loop'
  | 'workflow'
  | 'consensus'
  | 'failover'
  | 'internal';

/** Origins that represent a path picking Copilot on the user's behalf. */
export const COPILOT_AUTOMATIC_ORIGINS: readonly CopilotInvocationOrigin[] = [
  'automation',
  'review',
  'verification',
  'loop',
  'workflow',
  'consensus',
  'failover',
  'internal',
];

export function isAutomaticCopilotOrigin(origin: CopilotInvocationOrigin): boolean {
  return COPILOT_AUTOMATIC_ORIGINS.includes(origin);
}

export interface CopilotRouteFailure {
  ok: false;
  code: CopilotRouteFailureCode;
  /** Human-readable, secret-free explanation with a concrete remedy. */
  detail: string;
  /** The profile the failure relates to, when one was identified. */
  profileId?: string;
}

export type CopilotRouteOutcome =
  | { ok: true; route: ResolvedCopilotAccountRoute }
  | CopilotRouteFailure;

/** Safe-slug pattern shared by the schema, the home resolver, and the IPC layer.
 *  Profile IDs become directory names, so nothing outside this set is accepted. */
export const COPILOT_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The migration-created profile bound to the pre-existing Copilot home. */
export const COPILOT_LEGACY_PROFILE_ID = 'legacy';

export const COPILOT_DEFAULT_HOST = 'github.com';

/**
 * Normalize a GitHub host to a bare, lowercase hostname.
 *
 * The installed Copilot CLI writes `lastLoggedInUser.host` **with a scheme**
 * (`https://github.com`), while git remotes parse to a bare hostname
 * (`github.com`) and routing rules store bare hostnames. Comparing the two
 * spellings directly meant a freshly added account read as `identity-mismatch`
 * and no repository rule could ever match. Everything that persists or compares
 * a host goes through here.
 *
 * Accepts and strips: a scheme, a trailing slash, a trailing dot, surrounding
 * whitespace, and case. Deliberately does NOT strip a port or userinfo — those
 * would change which host is meant, so a value carrying them is left alone and
 * fails the exact-hostname schema loudly instead.
 */
export function normalizeCopilotHost(host: string | null | undefined): string {
  if (!host) {
    return '';
  }
  return host
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * Heal a persisted profile host into the exact-lowercase-hostname form the
 * schema demands.
 *
 * Records written before host normalisation existed hold whatever the Copilot
 * CLI put in its own config, which is a full origin (`https://github.com`), not
 * a hostname. Anything that re-validates a stored profile must repair it on
 * read, or a single such record fails validation for the whole set — including
 * the edits that would replace it.
 */
export function normalizeCopilotProfileHost<T extends { host: string }>(profile: T): T {
  const host = normalizeCopilotHost(profile.host) || COPILOT_DEFAULT_HOST;
  return host === profile.host ? profile : { ...profile, host };
}

/** The same healing for a routing rule, whose matcher carries its own host. */
export function normalizeCopilotRuleHost<T extends { matcher: object }>(rule: T): T {
  const matcher = rule.matcher as { host?: unknown };
  if (typeof matcher.host !== 'string') return rule;
  const host = normalizeCopilotHost(matcher.host) || COPILOT_DEFAULT_HOST;
  return host === matcher.host ? rule : { ...rule, matcher: { ...matcher, host } };
}
