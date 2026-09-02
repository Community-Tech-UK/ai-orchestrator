/**
 * The pure Copilot account routing resolver.
 *
 * Takes already-gathered evidence and returns exactly one profile or a typed
 * failure. No filesystem, no git, no settings access — every case in the spec's
 * test matrix is therefore a table test, and the resolution rules live in one
 * readable place instead of being spread across I/O.
 *
 * Precedence (spec §8):
 *   1. persisted resume profile   — an existing thread never moves
 *   2. explicit session override  — a deliberate human choice
 *   3. exact repository rule
 *   4. owner rule
 *   5. longest path-prefix rule
 *   6. default profile            — only outside every protected scope
 *
 * Fail-closed, always. Rule declaration order is never a tiebreaker: two
 * equal-precedence rules pointing at different profiles is `ambiguous-rules`,
 * not "the first one wins". And because evidence comes from *all* fetch
 * remotes, two remotes that would resolve to different accounts is
 * `ambiguous-remotes` rather than "whatever `origin` says".
 */

import type {
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
  CopilotInvocationOrigin,
  CopilotRouteFailureCode,
  CopilotRouteOutcome,
  CopilotRouteSource,
  ResolvedCopilotAccountRoute,
} from '../../../shared/types/copilot-account.types';
import { isAutomaticCopilotOrigin } from '../../../shared/types/copilot-account.types';
import type { GitHubRemoteIdentity } from '../../vcs/remotes/github-remote-identity';
import { isPathWithin, pathSegmentDepth } from '../../security/canonical-workspace-path';

export interface CopilotRouteInput {
  profiles: CopilotAccountProfile[];
  rules: CopilotAccountRoutingRule[];
  /** Already canonicalized (resolve + realpath + platform case folding). */
  canonicalWorkspacePath?: string;
  /** Every fetch remote on a known host, `origin` first. */
  remotes: GitHubRemoteIdentity[];
  /** User-selected profile for this session, if any. */
  explicitProfileId?: string;
  /**
   * Set when the user has explicitly confirmed an override that contradicts a
   * matched protected rule. Without it, such an override fails closed.
   */
  confirmProtectedOverride?: boolean;
  /** Profile stamped on the session being restored/resumed, if any. */
  persistedProfileId?: string;
  origin: CopilotInvocationOrigin;
  executionNodeId: string;
  /**
   * Canonical path per path-prefix rule ID, canonicalized with the same
   * function used for `canonicalWorkspacePath`. Rules absent from this map are
   * skipped: the caller could not canonicalize them, and a rule that cannot be
   * compared must not silently match.
   */
  canonicalRulePaths?: Record<string, string>;
}

function failure(
  code: CopilotRouteFailureCode,
  detail: string,
  profileId?: string,
): CopilotRouteOutcome {
  return { ok: false, code, detail, ...(profileId ? { profileId } : {}) };
}

function repositoryEvidence(
  remotes: GitHubRemoteIdentity[],
): ResolvedCopilotAccountRoute['repository'] | undefined {
  const preferred = remotes[0];
  return preferred
    ? { host: preferred.host, owner: preferred.owner, repo: preferred.repo }
    : undefined;
}

function buildRoute(
  profile: CopilotAccountProfile,
  source: CopilotRouteSource,
  input: CopilotRouteInput,
  ruleId?: string,
): ResolvedCopilotAccountRoute {
  const repository = repositoryEvidence(input.remotes);
  return {
    profileId: profile.id,
    source,
    ...(ruleId ? { ruleId } : {}),
    ...(repository ? { repository } : {}),
    executionNodeId: input.executionNodeId,
    profileLabel: profile.label,
    expectedLogin: profile.expectedLogin,
    host: profile.host,
  };
}

interface Decision {
  profileId: string;
  source: CopilotRouteSource;
  ruleId?: string;
}

type TierOutcome =
  | { kind: 'none' }
  | { kind: 'decided'; decision: Decision }
  | { kind: 'ambiguous'; profileIds: string[] };

function matchesRepository(
  rule: CopilotAccountRoutingRule,
  remote: GitHubRemoteIdentity,
): boolean {
  const matcher = rule.matcher;
  return (
    matcher.type === 'repository' &&
    matcher.host.toLowerCase() === remote.host &&
    matcher.owner.toLowerCase() === remote.owner &&
    matcher.repo.toLowerCase() === remote.repo
  );
}

function matchesOwner(rule: CopilotAccountRoutingRule, remote: GitHubRemoteIdentity): boolean {
  const matcher = rule.matcher;
  return (
    matcher.type === 'owner' &&
    matcher.host.toLowerCase() === remote.host &&
    matcher.owner.toLowerCase() === remote.owner
  );
}

function decideFromRules(
  hits: CopilotAccountRoutingRule[],
  source: CopilotRouteSource,
): TierOutcome {
  if (hits.length === 0) {
    return { kind: 'none' };
  }
  const profileIds = [...new Set(hits.map((rule) => rule.profileId))];
  if (profileIds.length > 1) {
    return { kind: 'ambiguous', profileIds };
  }
  return {
    kind: 'decided',
    decision: { profileId: profileIds[0], source, ruleId: hits[0].id },
  };
}

/** Resolve one remote through the repository tier, then the owner tier. */
function resolveRemote(remote: GitHubRemoteIdentity, rules: CopilotAccountRoutingRule[]): TierOutcome {
  const repositoryOutcome = decideFromRules(
    rules.filter((rule) => matchesRepository(rule, remote)),
    'repository',
  );
  if (repositoryOutcome.kind !== 'none') {
    return repositoryOutcome;
  }
  return decideFromRules(
    rules.filter((rule) => matchesOwner(rule, remote)),
    'owner',
  );
}

interface PathMatch {
  rule: CopilotAccountRoutingRule;
  depth: number;
}

function collectPathMatches(input: CopilotRouteInput): PathMatch[] {
  const canonicalPaths = input.canonicalRulePaths ?? {};
  const workspace = input.canonicalWorkspacePath;
  if (!workspace) {
    return [];
  }
  const matches: PathMatch[] = [];
  for (const rule of input.rules) {
    if (rule.matcher.type !== 'path-prefix') {
      continue;
    }
    const canonicalRulePath = canonicalPaths[rule.id];
    if (canonicalRulePath && isPathWithin(workspace, canonicalRulePath)) {
      matches.push({ rule, depth: pathSegmentDepth(canonicalRulePath) });
    }
  }
  return matches;
}

/** Longest (deepest) matching path prefix wins; ties across profiles are ambiguous. */
function resolvePath(matches: PathMatch[]): TierOutcome {
  if (matches.length === 0) {
    return { kind: 'none' };
  }
  const deepest = Math.max(...matches.map((match) => match.depth));
  return decideFromRules(
    matches.filter((match) => match.depth === deepest).map((match) => match.rule),
    'path-prefix',
  );
}

/**
 * Every distinct profile a matched *protected* rule points at. Used to block a
 * winner (or an override) that would take a protected workspace to a different
 * account than the protected rule intended.
 */
function protectedProfileIds(
  input: CopilotRouteInput,
  pathMatches: PathMatch[],
): string[] {
  const ids = new Set<string>();
  for (const match of pathMatches) {
    if (match.rule.isProtected) {
      ids.add(match.rule.profileId);
    }
  }
  for (const remote of input.remotes) {
    for (const rule of input.rules) {
      if (rule.isProtected && (matchesRepository(rule, remote) || matchesOwner(rule, remote))) {
        ids.add(rule.profileId);
      }
    }
  }
  return [...ids];
}

/**
 * Resolve exactly one Copilot account profile, or return a typed failure.
 *
 * Admission checks needing I/O (node binding, authentication, identity
 * verification) live in `copilot-account-routing-service.ts`; this decides only
 * *which* profile the evidence points to, plus the scope and automation-policy
 * checks it can make from the profile records alone.
 */
export function resolveCopilotAccountRoute(input: CopilotRouteInput): CopilotRouteOutcome {
  const { profiles } = input;
  if (profiles.length === 0) {
    return failure(
      'no-profiles',
      'No GitHub Copilot account profiles are configured. Add an account in Settings › GitHub Copilot Accounts.',
    );
  }

  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const pathMatches = collectPathMatches(input);
  const protectedIds = protectedProfileIds(input, pathMatches);

  // 1. Persisted resume profile. An existing thread keeps its account even if
  //    the rules changed underneath it — rule changes affect new sessions only
  //    (spec §11). Deliberately ahead of the protected-scope check: the session
  //    already exists, and silently moving it to another account is the thing
  //    that must never happen.
  if (input.persistedProfileId) {
    const profile = byId.get(input.persistedProfileId);
    if (!profile) {
      return failure(
        'profile-missing',
        'The Copilot account this session was created under no longer exists. Re-add that account, or start a new session.',
        input.persistedProfileId,
      );
    }
    return admit(profile, 'persisted', input);
  }

  // 2. Explicit session override. Subject to automation policy, and it cannot
  //    silently cross a matched protected rule without confirmation.
  if (input.explicitProfileId) {
    const profile = byId.get(input.explicitProfileId);
    if (!profile) {
      return failure(
        'profile-missing',
        'The selected Copilot account no longer exists. Choose another account.',
        input.explicitProfileId,
      );
    }
    if (
      !input.confirmProtectedOverride &&
      protectedIds.length > 0 &&
      !protectedIds.includes(profile.id)
    ) {
      return failure(
        'protected-scope-unmapped',
        `This workspace is inside a protected Copilot scope mapped to a different account. Confirm the override explicitly, or pick the mapped account.`,
        profile.id,
      );
    }
    return admit(profile, 'explicit', input);
  }

  // 3-5. Evidence. Each remote resolves independently through repository then
  //      owner rules; the path tier is the fallback for remotes (and
  //      workspaces) that no remote rule covers.
  const pathOutcome = resolvePath(pathMatches);
  if (pathOutcome.kind === 'ambiguous') {
    return failure(
      'ambiguous-rules',
      `This workspace matches equally deep path rules for more than one Copilot account (${pathOutcome.profileIds.join(', ')}). Remove or narrow the overlapping rules.`,
    );
  }

  const defaultProfile = profiles.find((profile) => profile.isDefault);
  const fallback: Decision | null =
    pathOutcome.kind === 'decided'
      ? pathOutcome.decision
      : defaultProfile
        ? { profileId: defaultProfile.id, source: 'default' }
        : null;

  const decisions: Decision[] = [];
  for (const remote of input.remotes) {
    const outcome = resolveRemote(remote, input.rules);
    if (outcome.kind === 'ambiguous') {
      return failure(
        'ambiguous-rules',
        `Remote ${remote.host}/${remote.displayPath} matches equal-precedence rules for more than one Copilot account (${outcome.profileIds.join(', ')}). Remove or narrow the overlapping rules.`,
      );
    }
    if (outcome.kind === 'decided') {
      decisions.push(outcome.decision);
    } else if (fallback) {
      // An unmapped remote is not evidence for a *different* account; it lands
      // wherever an unmapped workspace would. Including it here is what makes a
      // mapped-enterprise + unmapped-personal remote pair read as ambiguous
      // instead of quietly taking the enterprise rule.
      decisions.push(fallback);
    } else {
      // No rule, no path rule, no default: this remote resolves nowhere.
      decisions.push({ profileId: '', source: 'default' });
    }
  }

  const unresolved: Decision = { profileId: '', source: 'default' };
  const winner: Decision | null = (() => {
    if (decisions.length === 0) {
      // No remote evidence at all: the path tier or the default decides, and
      // "neither exists" is no-match rather than an ambiguity.
      return fallback ?? unresolved;
    }
    const distinct = [...new Set(decisions.map((decision) => decision.profileId))];
    if (distinct.length > 1) {
      return null;
    }
    // Prefer the most specific decision for provenance (rule-backed over the
    // fallback), since they all agree on the profile.
    return (
      decisions.find((decision) => decision.source === 'repository') ??
      decisions.find((decision) => decision.source === 'owner') ??
      decisions[0]
    );
  })();

  if (!winner) {
    const owners = [
      ...new Set(input.remotes.map((remote) => `${remote.host}/${remote.owner}`)),
    ];
    return failure(
      'ambiguous-remotes',
      `This workspace's GitHub remotes (${owners.join(', ')}) resolve to more than one Copilot account. Add a repository or owner rule that covers them, or choose an account explicitly.`,
    );
  }

  if (!winner.profileId) {
    return failure(
      protectedIds.length > 0 ? 'protected-scope-unmapped' : 'no-match',
      protectedIds.length > 0
        ? 'This workspace is inside a protected Copilot scope but no rule resolves it to an account, and there is no default. Map this workspace rather than falling back.'
        : 'No Copilot routing rule matches this workspace and no default account is set. Map this workspace or choose an account.',
    );
  }

  // A protected rule matched but the winner is a different account — an
  // overlapping owner/path rule is silently overriding the protected scope.
  // Fail closed and name the conflict rather than picking one.
  if (protectedIds.length > 0 && !protectedIds.includes(winner.profileId)) {
    return failure(
      'protected-scope-unmapped',
      `This workspace is inside a protected Copilot scope, but an overlapping rule routes it to a different account. Fix the overlapping owner/path rules.`,
    );
  }

  const profile = byId.get(winner.profileId);
  if (!profile) {
    return failure(
      'profile-missing',
      `A routing rule points at Copilot account "${winner.profileId}", which no longer exists. Fix the rule in Settings › GitHub Copilot Accounts.`,
      winner.profileId,
    );
  }

  if (winner.source === 'default') {
    // The default never services a protected scope, and it must be
    // default-eligible. The settings schema already rejects a matched-only
    // default; this is the hand-edited-config backstop.
    if (protectedIds.length > 0) {
      return failure(
        'protected-scope-unmapped',
        'This workspace is inside a protected Copilot scope but no rule resolves it to an account. Fix the overlapping owner/path rules rather than falling back to the default account.',
      );
    }
    if (profile.scopePolicy !== 'default-eligible') {
      return failure(
        'no-match',
        `The default Copilot account "${profile.label}" is matched-only and cannot service unmatched workspaces. Map this workspace or choose an account.`,
        profile.id,
      );
    }
  }

  return admit(profile, winner.source, input, winner.ruleId);
}

function admit(
  profile: CopilotAccountProfile,
  source: CopilotRouteSource,
  input: CopilotRouteInput,
  ruleId?: string,
): CopilotRouteOutcome {
  const policy = checkAutomationPolicy(profile, input.origin);
  if (policy) {
    return policy;
  }
  return { ok: true, route: buildRoute(profile, source, input, ruleId) };
}

/**
 * Per-profile automation policy. Returns a failure when the profile may not
 * service this origin, or `null` when it may.
 */
function checkAutomationPolicy(
  profile: CopilotAccountProfile,
  origin: CopilotInvocationOrigin,
): CopilotRouteOutcome | null {
  if (profile.automationPolicy === 'disabled') {
    return failure(
      'automation-disallowed',
      `Copilot account "${profile.label}" is disabled. Change its automation policy in Settings › GitHub Copilot Accounts, or select another provider.`,
      profile.id,
    );
  }
  if (profile.automationPolicy === 'manual-only' && isAutomaticCopilotOrigin(origin)) {
    return failure(
      'automation-disallowed',
      `Copilot account "${profile.label}" is manual-only, so it cannot be selected automatically (origin: ${origin}). Start the session yourself, change that profile's automation policy, or select another provider.`,
      profile.id,
    );
  }
  return null;
}

/**
 * Context-free invocation policy (spec §8.1): with no working directory there
 * is no repository or path evidence, so only an explicit profile, a persisted
 * session's profile, or a `default-eligible` default whose automation policy
 * permits the origin may run. Matched-only profiles are never reachable this
 * way by accident.
 */
export function resolveContextFreeCopilotRoute(
  input: Omit<CopilotRouteInput, 'canonicalWorkspacePath' | 'remotes' | 'canonicalRulePaths'>,
): CopilotRouteOutcome {
  const outcome = resolveCopilotAccountRoute({
    ...input,
    remotes: [],
    canonicalWorkspacePath: undefined,
    canonicalRulePaths: {},
  });
  if (!outcome.ok) {
    return outcome;
  }
  const profile = input.profiles.find((candidate) => candidate.id === outcome.route.profileId);
  const deliberate = outcome.route.source === 'explicit' || outcome.route.source === 'persisted';
  if (profile && profile.scopePolicy === 'matched-only' && !deliberate) {
    return failure(
      'no-match',
      `Copilot account "${profile.label}" is matched-only and cannot service a request with no workspace. Run this from a mapped workspace, or choose an account explicitly.`,
      profile.id,
    );
  }
  return outcome;
}

/**
 * Which profiles a *protected* rule claims for this workspace.
 *
 * Deliberately separate from `resolveCopilotAccountRoute`: this answers "whose
 * scope is this code in", not "may we spawn Copilot here". It runs no
 * precedence, no scope policy and no automation policy, so a `manual-only`,
 * signed-out or excluded profile still reports its claim. Licence containment
 * depends on that — a workspace does not stop being the employer's because
 * their seat happens to be unusable right now.
 *
 * Returns every distinct claimant. More than one is an ambiguity the caller
 * must fail closed on, exactly as the router does.
 */
export function collectProtectedScopeProfileIds(
  input: Pick<CopilotRouteInput, 'rules' | 'remotes' | 'canonicalWorkspacePath' | 'canonicalRulePaths'>,
): string[] {
  const routeInput = { ...input, profiles: [], origin: 'review', executionNodeId: '' } as CopilotRouteInput;
  return protectedProfileIds(routeInput, collectPathMatches(routeInput));
}
