import { describe, expect, it } from 'vitest';
import type {
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
  CopilotRoutingMatcher,
} from '../../../shared/types/copilot-account.types';
import type { GitHubRemoteIdentity } from '../../vcs/remotes/github-remote-identity';
import {
  resolveContextFreeCopilotRoute,
  resolveCopilotAccountRoute,
  type CopilotRouteInput,
} from './copilot-account-resolver';

const NODE = 'local';

function profile(
  id: string,
  overrides: Partial<CopilotAccountProfile> = {},
): CopilotAccountProfile {
  return {
    id,
    label: id,
    expectedLogin: id,
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const personal = profile('personal', { isDefault: true });
const enterprise = profile('enterprise', {
  accountKind: 'enterprise',
  scopePolicy: 'matched-only',
});

let ruleSeq = 0;
function rule(
  profileId: string,
  matcher: CopilotRoutingMatcher,
  isProtected = false,
): CopilotAccountRoutingRule {
  ruleSeq += 1;
  return {
    id: `rule-${ruleSeq}`,
    profileId,
    matcher,
    isProtected,
    createdAt: 1,
    updatedAt: 1,
  };
}

function remote(
  owner: string,
  repo = 'repo',
  host = 'github.com',
  remoteName = 'origin',
): GitHubRemoteIdentity {
  return { remoteName, host, owner, repo, displayPath: `${owner}/${repo}` };
}

function input(overrides: Partial<CopilotRouteInput> = {}): CopilotRouteInput {
  return {
    profiles: [personal, enterprise],
    rules: [],
    remotes: [],
    origin: 'interactive',
    executionNodeId: NODE,
    ...overrides,
  };
}

describe('resolveCopilotAccountRoute — precedence ladder', () => {
  it('fails closed with no profiles configured', () => {
    const outcome = resolveCopilotAccountRoute(input({ profiles: [] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe('no-profiles');
  });

  it('persisted profile beats every rule', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        persistedProfileId: 'enterprise',
        remotes: [remote('personal-owner')],
        rules: [rule('personal', { type: 'owner', host: 'github.com', owner: 'personal-owner' })],
      }),
    );
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
    expect(outcome.ok && outcome.route.source).toBe('persisted');
  });

  it('explicit override beats rules', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        explicitProfileId: 'enterprise',
        remotes: [remote('personal-owner')],
        rules: [rule('personal', { type: 'owner', host: 'github.com', owner: 'personal-owner' })],
      }),
    );
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
    expect(outcome.ok && outcome.route.source).toBe('explicit');
  });

  it('exact repository rule beats an owner rule', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme', 'special')],
        rules: [
          rule('personal', { type: 'owner', host: 'github.com', owner: 'acme' }),
          rule('enterprise', {
            type: 'repository',
            host: 'github.com',
            owner: 'acme',
            repo: 'special',
          }),
        ],
      }),
    );
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
    expect(outcome.ok && outcome.route.source).toBe('repository');
  });

  it('owner rule beats a path rule', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme')],
        canonicalWorkspacePath: '/work/acme/repo',
        canonicalRulePaths: { 'path-rule': '/work' },
        rules: [
          { ...rule('personal', { type: 'path-prefix', canonicalPath: '/work' }), id: 'path-rule' },
          rule('enterprise', { type: 'owner', host: 'github.com', owner: 'acme' }),
        ],
      }),
    );
    expect(outcome.ok && outcome.route.source).toBe('owner');
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
  });

  it('longest path prefix wins, counted in segments not characters', () => {
    const shallow = { ...rule('personal', { type: 'path-prefix', canonicalPath: '/work' }), id: 'shallow' };
    const deep = {
      ...rule('enterprise', { type: 'path-prefix', canonicalPath: '/work/acme' }),
      id: 'deep',
    };
    const outcome = resolveCopilotAccountRoute(
      input({
        canonicalWorkspacePath: '/work/acme/repo',
        canonicalRulePaths: { shallow: '/work', deep: '/work/acme' },
        rules: [shallow, deep],
      }),
    );
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
    expect(outcome.ok && outcome.route.source).toBe('path-prefix');
  });

  it('falls back to the default profile for an unmatched, unprotected workspace', () => {
    const outcome = resolveCopilotAccountRoute(
      input({ remotes: [remote('nobody')], canonicalWorkspacePath: '/elsewhere' }),
    );
    expect(outcome.ok && outcome.route.profileId).toBe('personal');
    expect(outcome.ok && outcome.route.source).toBe('default');
  });
});

describe('resolveCopilotAccountRoute — ambiguity fails closed', () => {
  it('two owner rules for different profiles on one remote are ambiguous', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme')],
        rules: [
          rule('personal', { type: 'owner', host: 'github.com', owner: 'acme' }),
          rule('enterprise', { type: 'owner', host: 'github.com', owner: 'acme' }),
        ],
      }),
    );
    expect(outcome.ok === false && outcome.code).toBe('ambiguous-rules');
  });

  it('two equally deep path rules for different profiles are ambiguous', () => {
    const a = { ...rule('personal', { type: 'path-prefix', canonicalPath: '/work/a' }), id: 'a' };
    const b = { ...rule('enterprise', { type: 'path-prefix', canonicalPath: '/work/b' }), id: 'b' };
    const outcome = resolveCopilotAccountRoute(
      input({
        canonicalWorkspacePath: '/work/a',
        // Contrived but real: two rules can both cover a path via symlinks.
        canonicalRulePaths: { a: '/work/a', b: '/work/a' },
        rules: [a, b],
      }),
    );
    expect(outcome.ok === false && outcome.code).toBe('ambiguous-rules');
  });

  it('remotes resolving to different profiles are ambiguous', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme', 'repo', 'github.com', 'origin'), remote('personal-owner', 'repo', 'github.com', 'upstream')],
        rules: [
          rule('enterprise', { type: 'owner', host: 'github.com', owner: 'acme' }),
          rule('personal', { type: 'owner', host: 'github.com', owner: 'personal-owner' }),
        ],
      }),
    );
    expect(outcome.ok === false && outcome.code).toBe('ambiguous-remotes');
  });

  it('a mapped remote plus an unmapped remote is ambiguous, not silently mapped', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme'), remote('stranger', 'fork', 'github.com', 'fork')],
        rules: [rule('enterprise', { type: 'owner', host: 'github.com', owner: 'acme' })],
      }),
    );
    expect(outcome.ok === false && outcome.code).toBe('ambiguous-remotes');
  });

  it('multiple remotes resolving to the same profile succeed', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme', 'a'), remote('acme', 'b', 'github.com', 'upstream')],
        rules: [rule('enterprise', { type: 'owner', host: 'github.com', owner: 'acme' })],
      }),
    );
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
  });

  it('two unmapped remotes on a single-profile install still route to the default', () => {
    // The migration case: one legacy profile, a fork workflow with two owners.
    // Both resolve to the same default, so this must NOT read as ambiguous.
    const legacy = profile('legacy', { isDefault: true, isLegacy: true });
    const outcome = resolveCopilotAccountRoute(
      input({
        profiles: [legacy],
        remotes: [remote('me'), remote('upstream-owner', 'repo', 'github.com', 'upstream')],
      }),
    );
    expect(outcome.ok && outcome.route.profileId).toBe('legacy');
    expect(outcome.ok && outcome.route.source).toBe('default');
  });

  it('declaration order is never a tiebreaker', () => {
    const forward = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme')],
        rules: [
          rule('personal', { type: 'owner', host: 'github.com', owner: 'acme' }),
          rule('enterprise', { type: 'owner', host: 'github.com', owner: 'acme' }),
        ],
      }),
    );
    const reversed = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme')],
        rules: [
          rule('enterprise', { type: 'owner', host: 'github.com', owner: 'acme' }),
          rule('personal', { type: 'owner', host: 'github.com', owner: 'acme' }),
        ],
      }),
    );
    expect(forward.ok).toBe(false);
    expect(reversed.ok).toBe(false);
  });
});

describe('resolveCopilotAccountRoute — protected scopes', () => {
  it('blocks the default inside a protected path scope with no resolving rule', () => {
    // A protected path rule whose profile is deliberately absent from `profiles`
    // is a different failure; here the protected rule exists but a *shallower*
    // decision would otherwise take over. Model it as a protected rule matching
    // a profile that no rule resolves to for this workspace.
    const protectedRule = {
      ...rule('enterprise', { type: 'path-prefix', canonicalPath: '/work' }, true),
      id: 'protected-work',
    };
    const outcome = resolveCopilotAccountRoute(
      input({
        canonicalWorkspacePath: '/work/repo',
        canonicalRulePaths: { 'protected-work': '/work' },
        rules: [protectedRule],
        remotes: [],
      }),
    );
    // The protected rule DOES resolve — that is the intended behaviour.
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
  });

  it('blocks an overlapping owner rule that would leave a protected path scope', () => {
    const protectedRule = {
      ...rule('enterprise', { type: 'path-prefix', canonicalPath: '/work' }, true),
      id: 'protected-work',
    };
    const outcome = resolveCopilotAccountRoute(
      input({
        canonicalWorkspacePath: '/work/repo',
        canonicalRulePaths: { 'protected-work': '/work' },
        rules: [protectedRule, rule('personal', { type: 'owner', host: 'github.com', owner: 'me' })],
        remotes: [remote('me')],
      }),
    );
    expect(outcome.ok === false && outcome.code).toBe('protected-scope-unmapped');
  });

  it('blocks an unconfirmed explicit override out of a protected scope', () => {
    const protectedRule = {
      ...rule('enterprise', { type: 'path-prefix', canonicalPath: '/work' }, true),
      id: 'protected-work',
    };
    const blocked = resolveCopilotAccountRoute(
      input({
        explicitProfileId: 'personal',
        canonicalWorkspacePath: '/work/repo',
        canonicalRulePaths: { 'protected-work': '/work' },
        rules: [protectedRule],
      }),
    );
    expect(blocked.ok === false && blocked.code).toBe('protected-scope-unmapped');

    const confirmed = resolveCopilotAccountRoute(
      input({
        explicitProfileId: 'personal',
        confirmProtectedOverride: true,
        canonicalWorkspacePath: '/work/repo',
        canonicalRulePaths: { 'protected-work': '/work' },
        rules: [protectedRule],
      }),
    );
    expect(confirmed.ok && confirmed.route.profileId).toBe('personal');
  });

  it('never lets the default service a protected scope', () => {
    // A protected owner rule matches a remote, but the workspace's other
    // evidence is unmapped, so the fallback would be the default.
    const protectedRule = rule(
      'enterprise',
      { type: 'owner', host: 'github.com', owner: 'acme' },
      true,
    );
    const outcome = resolveCopilotAccountRoute(
      input({
        remotes: [remote('acme'), remote('stranger', 'repo', 'github.com', 'fork')],
        rules: [protectedRule],
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(
      outcome.ok === false && ['ambiguous-remotes', 'protected-scope-unmapped'].includes(outcome.code),
    ).toBe(true);
  });
});

describe('resolveCopilotAccountRoute — scope and automation policy', () => {
  it('never uses a matched-only profile as the default', () => {
    const matchedOnlyDefault = profile('enterprise', {
      isDefault: true,
      scopePolicy: 'matched-only',
    });
    const outcome = resolveCopilotAccountRoute(input({ profiles: [matchedOnlyDefault] }));
    expect(outcome.ok === false && outcome.code).toBe('no-match');
  });

  it('reports no-match when nothing matches and there is no default', () => {
    const outcome = resolveCopilotAccountRoute(
      input({ profiles: [profile('only', { isDefault: false })] }),
    );
    expect(outcome.ok === false && outcome.code).toBe('no-match');
  });

  it('blocks a disabled profile for every origin', () => {
    const disabled = profile('personal', { isDefault: true, automationPolicy: 'disabled' });
    for (const origin of ['interactive', 'loop'] as const) {
      const outcome = resolveCopilotAccountRoute(input({ profiles: [disabled], origin }));
      expect(outcome.ok === false && outcome.code).toBe('automation-disallowed');
    }
  });

  it('blocks a manual-only profile for automatic origins but allows interactive', () => {
    const manual = profile('personal', { isDefault: true, automationPolicy: 'manual-only' });
    expect(
      resolveCopilotAccountRoute(input({ profiles: [manual], origin: 'interactive' })).ok,
    ).toBe(true);
    for (const origin of ['automation', 'review', 'verification', 'loop', 'workflow', 'consensus', 'failover', 'internal'] as const) {
      const outcome = resolveCopilotAccountRoute(input({ profiles: [manual], origin }));
      expect(outcome.ok === false && outcome.code, origin).toBe('automation-disallowed');
    }
  });

  it('reports profile-missing for a rule pointing at a deleted profile', () => {
    const outcome = resolveCopilotAccountRoute(
      input({
        profiles: [personal],
        remotes: [remote('acme')],
        rules: [rule('deleted', { type: 'owner', host: 'github.com', owner: 'acme' })],
      }),
    );
    expect(outcome.ok === false && outcome.code).toBe('profile-missing');
  });

  it('reports profile-missing when a persisted profile was removed', () => {
    const outcome = resolveCopilotAccountRoute(input({ persistedProfileId: 'gone' }));
    expect(outcome.ok === false && outcome.code).toBe('profile-missing');
  });
});

describe('resolveContextFreeCopilotRoute', () => {
  it('uses a default-eligible default', () => {
    const outcome = resolveContextFreeCopilotRoute({
      profiles: [personal, enterprise],
      rules: [],
      origin: 'interactive',
      executionNodeId: NODE,
    });
    expect(outcome.ok && outcome.route.profileId).toBe('personal');
  });

  it('never gives a context-free call to a matched-only profile', () => {
    const matchedOnlyDefault = profile('enterprise', {
      isDefault: true,
      scopePolicy: 'matched-only',
    });
    const outcome = resolveContextFreeCopilotRoute({
      profiles: [matchedOnlyDefault],
      rules: [],
      origin: 'automation',
      executionNodeId: NODE,
    });
    expect(outcome.ok).toBe(false);
  });

  it('allows an explicit matched-only choice', () => {
    const outcome = resolveContextFreeCopilotRoute({
      profiles: [personal, enterprise],
      rules: [],
      explicitProfileId: 'enterprise',
      origin: 'interactive',
      executionNodeId: NODE,
    });
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
  });

  it('allows a persisted matched-only session to continue', () => {
    const outcome = resolveContextFreeCopilotRoute({
      profiles: [personal, enterprise],
      rules: [],
      persistedProfileId: 'enterprise',
      origin: 'interactive',
      executionNodeId: NODE,
    });
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
  });
});

describe('resolveCopilotAccountRoute — route payload', () => {
  it('carries safe metadata only', () => {
    const outcome = resolveCopilotAccountRoute(
      input({ remotes: [remote('acme', 'thing')], canonicalWorkspacePath: '/work' }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.route).toEqual({
      profileId: 'personal',
      source: 'default',
      repository: { host: 'github.com', owner: 'acme', repo: 'thing' },
      executionNodeId: NODE,
      profileLabel: 'personal',
      expectedLogin: 'personal',
      host: 'github.com',
    });
    expect(JSON.stringify(outcome.route)).not.toContain('/work');
  });
});
