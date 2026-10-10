/**
 * Provider account pools (Claude Code, Codex CLI and OpenCode/MiMo) — shared
 * domain types.
 *
 * A *provider account profile* is one Claude, ChatGPT or MiMo Token Plan
 * subscription the user owns. Claude and Codex are isolated by pointing the
 * unmodified vendor CLI at its own home directory (`CLAUDE_CONFIG_DIR` /
 * `CODEX_HOME`); OpenCode/MiMo keeps ONE key store and session store and maps
 * each account to its own provider name (`aio-mimo-<profileId>`), injected at
 * spawn through `OPENCODE_CONFIG_CONTENT`. Profiles of one provider form a
 * *pool*: Claude/Codex invocations and logical MiMo model requests resolve one
 * profile before the CLI starts. A usage-limit rejection on one profile can
 * move the conversation to another profile of the same provider.
 * See docs/plans/2026-10-10-mimo-multi-account_plan_completed.md.
 *
 * Like the Copilot account types these are deliberately secret-free: a profile
 * carries labels and a verified identity string, never a token, a keychain
 * reference or an absolute home directory. The home is derived on the executing
 * node from the validated profile ID (see `provider-account-home-resolver.ts`).
 */

import type { CopilotInvocationOrigin } from './copilot-account.types';
import { isAutomaticCopilotOrigin } from './copilot-account.types';

export type PooledProvider = 'claude' | 'codex' | 'opencode';

export const POOLED_PROVIDERS: readonly PooledProvider[] = ['claude', 'codex', 'opencode'];

export function isPooledProvider(provider: unknown): provider is PooledProvider {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode';
}

/** MiMo Token Plan regions. Each region is its own OpenCode built-in provider. */
export type OpenCodeAccountRegion = 'ams' | 'sgp' | 'cn';

export const OPENCODE_ACCOUNT_REGIONS: readonly OpenCodeAccountRegion[] = ['ams', 'sgp', 'cn'];

/**
 * Prefix of the OpenCode provider names AIO defines per non-legacy MiMo
 * account in `OPENCODE_CONFIG_CONTENT`. Filtered out of AIO's own model
 * discovery; OpenCode resolves the key for such a name from its own key store.
 */
export const OPENCODE_ACCOUNT_PROVIDER_PREFIX = 'aio-mimo-';

/**
 * Only logical MiMo Token Plan selections participate in the MiMo account
 * pool. OpenCode's native default/auto and other backend ids retain their own
 * authentication. Routed aio-mimo-* ids exist only inside the adapter.
 */
export function isLogicalMiMoModel(model: string | null | undefined): boolean {
  return /^xiaomi-token-plan(?:-(?:ams|sgp|cn))?\/\S+$/.test(model?.trim() ?? '');
}

/** Whether a profile may be selected by paths that pick an account automatically. */
export type AccountAutomationPolicy = 'allow-routed' | 'manual-only' | 'disabled';

export interface ProviderAccountProfile {
  /** Immutable safe slug. Becomes a directory name, so it is strictly validated. */
  id: string;
  provider: PooledProvider;
  /** User-facing label, e.g. "Max A". */
  label: string;
  /** Verified account email; null until the first verification. */
  expectedIdentity: string | null;
  /** Codex: ChatGPT account id. Claude: organisation uuid. Pool sanity only. */
  expectedAccountKey: string | null;
  /** Display only, e.g. "max", "pro". */
  planLabel: string | null;
  /** Lower is preferred; unique within a provider. */
  priority: number;
  enabled: boolean;
  automationPolicy: AccountAutomationPolicy;
  /** Bound to `~/.claude` / `~/.codex`, never to a derived home. */
  isLegacy: boolean;
  /**
   * OpenCode/MiMo only (schema-enforced): the Token Plan region, which decides
   * the derived provider name and base URL. Absent for Claude/Codex.
   */
  region?: OpenCodeAccountRegion;
  /**
   * OpenCode/MiMo only, optional (Decision 8): Chrome profile folder name whose
   * MiMo console sign-in the quota reader uses for this account's allowance.
   * A bare folder name ("Default", "Profile 1"), never a path.
   */
  chromeProfile?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The OpenCode provider name one account maps to (Decision 1: never stored
 * free-form). Legacy keeps the pre-existing built-in region provider; every
 * other account is a `aio-mimo-<profileId>` provider AIO defines at spawn.
 */
export function opencodeAccountProviderName(
  profile: Pick<ProviderAccountProfile, 'id' | 'isLegacy' | 'region'>,
): string {
  if (profile.isLegacy) {
    if (!profile.region) {
      throw new Error(`OpenCode account profile ${profile.id} has no Token Plan region.`);
    }
    return `xiaomi-token-plan-${profile.region}`;
  }
  return `${OPENCODE_ACCOUNT_PROVIDER_PREFIX}${profile.id}`;
}

/** True for the per-account provider names AIO defines (not OpenCode backends). */
export function isOpenCodeAccountProviderName(providerName: string): boolean {
  return providerName.startsWith(OPENCODE_ACCOUNT_PROVIDER_PREFIX);
}

export type AccountFailoverMode = 'automatic' | 'ask' | 'off';

/**
 * How a conversation continues on another profile. `shared-store` symlinks the
 * Claude `projects/` session store into every profile home (Codex already
 * shares its session store), so native resume can continue the same thread;
 * `replay` always starts a fresh provider session and replays the transcript.
 */
export type AccountContinuationMode = 'shared-store' | 'replay';

export interface AccountPreemptivePolicy {
  /** Steer new sessions away from profiles at or above `thresholdPct`. */
  newSessions: boolean;
  /** Move live sessions at a turn boundary when their profile crosses the threshold. */
  liveSessionsAtTurnBoundary: boolean;
  /** Five-hour utilisation or effective MiMo plan/monthly/compensation usage, 1..100. */
  thresholdPct: number;
}

export interface ProviderAccountPoolPolicy {
  failoverMode: AccountFailoverMode;
  continuation: AccountContinuationMode;
  preemptive: AccountPreemptivePolicy;
  switchCooldownMs: number;
  /** Upper bound; the effective cap is also limited to `profileCount - 1`. */
  maxSwitchesPerTurn: number;
  /** Required before a second profile can be enabled (spec §5). */
  acknowledgedOwnershipAt: number | null;
}

export type ProviderAccountPools = Record<PooledProvider, ProviderAccountPoolPolicy>;

export type AccountRouteSource =
  | 'explicit'
  | 'default'
  | 'failover'
  | 'persisted'
  | 'legacy'
  | 'preemptive';

/**
 * Safe routing metadata attached to a spawn. Contains no filesystem path and no
 * credential material, so it is safe to put on `UnifiedSpawnOptions`, persist
 * on a session, log, and send over remote-node RPC.
 */
export interface ResolvedAccountRoute {
  provider: PooledProvider;
  profileId: string;
  source: AccountRouteSource;
  executionNodeId: string;
  profileLabel?: string;
  expectedIdentity?: string;
  /**
   * OpenCode/MiMo only: the account's Token Plan region. The executing node
   * needs it to derive the provider name and read the region's model metadata
   * from its own `opencode`. Safe metadata, never a credential.
   */
  region?: OpenCodeAccountRegion;
}

export type AccountBindingState =
  | 'authenticated'
  | 'unauthenticated'
  | 'identity-mismatch'
  | 'unavailable';

/** Node-local authentication health for one profile. Derived, never persisted centrally. */
export interface AccountBindingStatus {
  provider: PooledProvider;
  profileId: string;
  nodeId: string;
  state: AccountBindingState;
  observedIdentity?: string;
  observedAccountKey?: string;
  observedPlan?: string;
  checkedAt: number;
  errorCode?: string;
}

export type AccountRouteFailureCode =
  | 'no-profiles'
  | 'profile-missing'
  | 'profile-disabled'
  | 'profile-not-bound-on-node'
  | 'profile-unauthenticated'
  | 'profile-identity-mismatch'
  | 'automation-disallowed'
  | 'all-profiles-parked'
  | 'ownership-not-acknowledged';

export interface AccountRouteFailure {
  ok: false;
  code: AccountRouteFailureCode;
  /** Human-readable, secret-free explanation with a concrete remedy. */
  detail: string;
  profileId?: string;
}

export type AccountRouteOutcome =
  | { ok: true; route: ResolvedAccountRoute }
  | AccountRouteFailure;

/** Where an invocation came from. Shared with Copilot routing. */
export type AccountInvocationOrigin = CopilotInvocationOrigin;

export function isAutomaticAccountOrigin(origin: AccountInvocationOrigin): boolean {
  return isAutomaticCopilotOrigin(origin);
}

/** Why a live conversation moved to another profile. */
export type AccountHandoffKind = 'explicit' | 'failover' | 'preemptive';

/** Named reasons the selector gives for skipping a profile. */
export type AccountVetoReason =
  | 'disabled'
  | 'automation-disallowed'
  | 'excluded'
  | 'unbound'
  | 'parked'
  | 'exhausted'
  /** Could run only on purchased credits, which this kind of work may not spend. */
  | 'credits-only'
  | 'over-threshold';

/** Profile IDs become directory names. Shared by the schema, resolver and IPC layer. */
export const PROVIDER_ACCOUNT_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Chrome profile folder names a MiMo account may name for its console sign-in
 * ("Default", "Profile 1"). A plain folder name, never a path. Keep in sync
 * with `AccountChromeProfileSchema` in the contracts package.
 */
export const ACCOUNT_CHROME_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

/**
 * The migration-created profile bound to `~/.claude` or `~/.codex`. A profile
 * is legacy exactly when its id is this value (the schema enforces
 * `isLegacy === (id === 'legacy')`), so a wire route needs no extra flag: the
 * legacy route sets no `CLAUDE_CONFIG_DIR` and links the shared
 * `~/.codex/auth.json`.
 */
export const LEGACY_ACCOUNT_PROFILE_ID = 'legacy';

export function isLegacyAccountProfileId(profileId: string | null | undefined): boolean {
  return profileId === LEGACY_ACCOUNT_PROFILE_ID;
}

export const MAX_PROFILES_PER_PROVIDER = 8;

export const DEFAULT_ACCOUNT_POOL_POLICY: ProviderAccountPoolPolicy = Object.freeze({
  failoverMode: 'ask',
  continuation: 'shared-store',
  preemptive: Object.freeze({ newSessions: true, liveSessionsAtTurnBoundary: false, thresholdPct: 90 }),
  switchCooldownMs: 300_000,
  maxSwitchesPerTurn: 3,
  acknowledgedOwnershipAt: null,
}) as ProviderAccountPoolPolicy;

export function defaultProviderAccountPools(): ProviderAccountPools {
  return {
    claude: clonePoolPolicy(DEFAULT_ACCOUNT_POOL_POLICY),
    codex: clonePoolPolicy(DEFAULT_ACCOUNT_POOL_POLICY),
    opencode: clonePoolPolicy(DEFAULT_ACCOUNT_POOL_POLICY),
  };
}

export function clonePoolPolicy(policy: ProviderAccountPoolPolicy): ProviderAccountPoolPolicy {
  return { ...policy, preemptive: { ...policy.preemptive } };
}

/** Display label for a provider's accounts. */
export function pooledProviderLabel(provider: PooledProvider): string {
  return provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'MiMo';
}
