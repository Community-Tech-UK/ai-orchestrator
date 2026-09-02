import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CopilotAccountBindingStatus,
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
} from '../../../shared/types/copilot-account.types';
import type { GitHubRemoteIdentity } from '../../vcs/remotes/github-remote-identity';
import type { CopilotAccountBindingService } from './copilot-account-binding-service';
import { CopilotAccountRoutingService } from './copilot-account-routing-service';
import {
  _setCopilotAccountEventSinkForTesting,
  type CopilotAccountEvent,
} from './copilot-account-events';

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

function remote(owner: string, repo = 'repo'): GitHubRemoteIdentity {
  return {
    remoteName: 'origin',
    host: 'github.com',
    owner,
    repo,
    displayPath: `${owner}/${repo}`,
  };
}

function bindingService(
  statusByProfile: Record<string, CopilotAccountBindingStatus['state']>,
): CopilotAccountBindingService {
  const invalidate = vi.fn();
  return {
    checkBinding: vi.fn(async (target: CopilotAccountProfile, nodeId: string) => ({
      profileId: target.id,
      nodeId,
      state: statusByProfile[target.id] ?? 'authenticated',
      checkedAt: 1,
    })),
    invalidate,
  } as unknown as CopilotAccountBindingService;
}

interface Fixture {
  profiles?: CopilotAccountProfile[];
  rules?: CopilotAccountRoutingRule[];
  remotes?: GitHubRemoteIdentity[];
  bindings?: Record<string, CopilotAccountBindingStatus['state']>;
  excluded?: boolean;
}

function makeService(fixture: Fixture = {}): CopilotAccountRoutingService {
  return new CopilotAccountRoutingService({
    readSettings: () => ({
      copilotAccountProfiles: fixture.profiles ?? [profile('personal', { isDefault: true })],
      copilotAccountRoutingRules: fixture.rules ?? [],
    }),
    collectRemotes: () => fixture.remotes ?? [],
    canonicalize: (path) => path,
    isProviderExcluded: () => fixture.excluded ?? false,
    bindingService: bindingService(fixture.bindings ?? {}),
  });
}

const events: CopilotAccountEvent[] = [];

beforeEach(() => {
  events.length = 0;
  _setCopilotAccountEventSinkForTesting((event) => events.push(event));
});

describe('CopilotAccountRoutingService.resolveRouteForSpawn', () => {
  it('resolves the default profile for an unmatched workspace', async () => {
    const outcome = await makeService().resolveRouteForSpawn({
      workingDirectory: '/w',
      origin: 'interactive',
    });
    expect(outcome.ok && outcome.route.profileId).toBe('personal');
    expect(events.map((event) => event.event)).toContain('copilot_account_route_resolved');
  });

  it('blocks an unauthenticated profile', async () => {
    const outcome = await makeService({ bindings: { personal: 'unauthenticated' } })
      .resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    expect(outcome.ok === false && outcome.code).toBe('profile-unauthenticated');
  });

  it('blocks on identity mismatch even though a valid token exists for another account', async () => {
    const outcome = await makeService({ bindings: { personal: 'identity-mismatch' } })
      .resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    expect(outcome.ok === false && outcome.code).toBe('profile-identity-mismatch');
    expect(events.map((event) => event.event)).toContain('copilot_account_identity_mismatch');
  });

  it('blocks an unavailable binding as not-bound-on-node', async () => {
    const outcome = await makeService({ bindings: { personal: 'unavailable' } })
      .resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    expect(outcome.ok === false && outcome.code).toBe('profile-not-bound-on-node');
  });

  it('never returns a different profile when the resolved one fails admission', async () => {
    const outcome = await makeService({
      profiles: [
        profile('enterprise', { isDefault: false, scopePolicy: 'matched-only' }),
        profile('personal', { isDefault: true }),
      ],
      rules: [
        {
          id: 'r1',
          profileId: 'enterprise',
          matcher: { type: 'owner', host: 'github.com', owner: 'acme' },
          isProtected: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      remotes: [remote('acme')],
      bindings: { enterprise: 'unauthenticated' },
    }).resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.profileId).toBe('enterprise');
    expect(JSON.stringify(outcome)).not.toContain('personal');
  });

  it('re-verifies the binding on a cached decision', async () => {
    const bindings = bindingService({});
    const service = new CopilotAccountRoutingService({
      readSettings: () => ({
        copilotAccountProfiles: [profile('personal', { isDefault: true })],
        copilotAccountRoutingRules: [],
      }),
      collectRemotes: () => [],
      canonicalize: (path) => path,
      isProviderExcluded: () => false,
      bindingService: bindings,
    });

    await service.resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    await service.resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });

    // Decision cached, admission not: a stale binding must never let a spawn
    // through on the strength of an earlier check.
    expect(bindings.checkBinding).toHaveBeenCalledTimes(2);
  });

  it('honours the coarse providersExcludedFromAutomation override before per-profile policy', async () => {
    const service = makeService({ excluded: true });
    const automatic = await service.resolveRouteForSpawn({
      workingDirectory: '/w',
      origin: 'loop',
    });
    expect(automatic.ok === false && automatic.code).toBe('automation-disallowed');

    // An explicit human choice is still allowed — the exclusion list bars
    // AUTOMATIC selection only.
    const interactive = await service.resolveRouteForSpawn({
      workingDirectory: '/w',
      origin: 'interactive',
    });
    expect(interactive.ok).toBe(true);
  });

  it('skips local binding verification for a remote node and carries the expected identity', async () => {
    const outcome = await makeService({ bindings: { personal: 'unauthenticated' } })
      .resolveRouteForSpawn({
        workingDirectory: '/w',
        origin: 'interactive',
        executionNodeId: 'worker-1',
      });
    // The controller cannot read another machine's Copilot home; the worker
    // verifies its own binding before spawning.
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.route.expectedLogin).toBe('personal');
    expect(outcome.ok && outcome.route.executionNodeId).toBe('worker-1');
  });

  it('falls back to the implicit legacy route when no profiles are configured', async () => {
    // Pre-migration / un-upgraded install: one Copilot home, exactly today's
    // behaviour. Blocking here would break every working single-account setup
    // at upgrade time, and with no profiles there is no second account to leak
    // to.
    const outcome = await makeService({ profiles: [] }).resolveRouteForSpawn({
      workingDirectory: '/w',
      origin: 'interactive',
    });
    expect(outcome.ok && outcome.route.profileId).toBe('legacy');
    expect(outcome.ok && outcome.route.source).toBe('legacy');
  });

  it('emits route events with no path or secret in the payload', async () => {
    await makeService({ bindings: { personal: 'unauthenticated' } }).resolveRouteForSpawn({
      workingDirectory: '/Users/me/private/work',
      origin: 'automation',
    });
    const blocked = events.find((event) => event.event === 'copilot_account_route_blocked');
    expect(blocked?.failureCode).toBe('profile-unauthenticated');
    expect(JSON.stringify(events)).not.toContain('/Users/me/private/work');
  });

  it('reports no-profiles when settings cannot be read', async () => {
    const service = new CopilotAccountRoutingService({
      readSettings: () => {
        throw new Error('settings unavailable');
      },
    });
    const outcome = await service.resolveRouteForSpawn({ origin: 'interactive' });
    expect(outcome.ok === false && outcome.code).toBe('no-profiles');
  });
});

describe('CopilotAccountRoutingService cache invalidation', () => {
  it('recomputes after invalidate()', async () => {
    const collect = vi.fn(() => [] as GitHubRemoteIdentity[]);
    const service = new CopilotAccountRoutingService({
      readSettings: () => ({
        copilotAccountProfiles: [profile('personal', { isDefault: true })],
        copilotAccountRoutingRules: [],
      }),
      collectRemotes: collect,
      canonicalize: (path) => path,
      isProviderExcluded: () => false,
      bindingService: bindingService({}),
    });

    await service.resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    await service.resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    expect(collect).toHaveBeenCalledTimes(1);

    service.invalidate();
    await service.resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('recomputes when the profiles change under it', async () => {
    let profiles = [profile('personal', { isDefault: true })];
    const service = new CopilotAccountRoutingService({
      readSettings: () => ({
        copilotAccountProfiles: profiles,
        copilotAccountRoutingRules: [],
      }),
      collectRemotes: () => [],
      canonicalize: (path) => path,
      isProviderExcluded: () => false,
      bindingService: bindingService({}),
    });

    expect(
      (await service.resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' })).ok,
    ).toBe(true);

    profiles = [profile('enterprise', { isDefault: true })];
    const outcome = await service.resolveRouteForSpawn({
      workingDirectory: '/w',
      origin: 'interactive',
    });
    expect(outcome.ok && outcome.route.profileId).toBe('enterprise');
  });
});

describe('a rule stored with a scheme-prefixed host', () => {
  // Found by the completion gate on 2026-08-30. The store and the Doctor both
  // repaired such hosts on read; the routing service repaired only PROFILE
  // hosts and passed rule matchers through untouched. Matchers are compared
  // against a git remote host, which is always parsed bare, so the rule matched
  // nothing — and because this rule is PROTECTED, the workspace fell through to
  // the default account rather than failing closed. Settings and Doctor showed
  // the rule as healthy the whole time.
  const enterpriseRule = {
    id: 'rule-scheme',
    profileId: 'enterprise',
    matcher: { type: 'owner', host: 'https://github.com', owner: 'acme' },
    isProtected: true,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as CopilotAccountRoutingRule;

  it('still routes to the rule owner, not the default account', async () => {
    const outcome = await makeService({
      profiles: [profile('personal', { isDefault: true }), profile('enterprise')],
      rules: [enterpriseRule],
      remotes: [remote('acme')],
      bindings: { enterprise: 'authenticated', personal: 'authenticated' },
    }).resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.route.profileId).toBe('enterprise');
  });
});

describe('route cache key field boundaries', () => {
  // This cache decides which GitHub identity a session runs as, so a collision
  // is an account mix-up, not a stale-read nuisance. The separator is a NUL
  // precisely because a value can be empty and two adjacent fields could
  // otherwise merge: `explicit='' , persisted='x'` and `explicit='x',
  // persisted=''` collapse to the same string under an empty separator.
  const fixture = {
    profiles: [profile('personal', { isDefault: true }), profile('enterprise')],
    bindings: { personal: 'authenticated' as const, enterprise: 'authenticated' as const },
  };

  it('does not serve a persisted decision to an explicit request', async () => {
    const service = makeService(fixture);
    const persisted = await service.resolveRouteForSpawn({
      workingDirectory: '/w',
      origin: 'interactive',
      persistedProfileId: 'enterprise',
    });
    const explicit = await service.resolveRouteForSpawn({
      workingDirectory: '/w',
      origin: 'interactive',
      explicitProfileId: 'enterprise',
    });

    expect(persisted.ok && persisted.route.source).toBe('persisted');
    // Same profile, different provenance. Sharing a cache entry here would
    // mislabel how the account was chosen — and the two are not interchangeable
    // for the protected-scope override checks that read `source`.
    expect(explicit.ok && explicit.route.source).toBe('explicit');
  });
});

/**
 * Licence containment: work inside a protected ENTERPRISE scope is checked on
 * that same seat, so the coarse "never auto-pick Copilot" guard must yield for
 * the checking origins only. Every other automatic origin keeps the guard.
 */
describe('CopilotAccountRoutingService — licence-mandated checking carve-out', () => {
  const enterprise = profile('work', {
    accountKind: 'enterprise',
    scopePolicy: 'matched-only',
  });
  const protectedRule: CopilotAccountRoutingRule = {
    id: 'r-work',
    profileId: 'work',
    matcher: { type: 'path-prefix', canonicalPath: '/work/ebrd' },
    isProtected: true,
    createdAt: 1,
    updatedAt: 1,
  };

  function excludedService(): CopilotAccountRoutingService {
    return makeService({
      profiles: [profile('personal', { isDefault: true }), enterprise],
      rules: [protectedRule],
      excluded: true,
    });
  }

  it.each(['review', 'verification', 'consensus'] as const)(
    'permits a %s inside a protected enterprise scope despite the exclusion',
    async (origin) => {
      const outcome = await excludedService().resolveRouteForSpawn({
        workingDirectory: '/work/ebrd/repo',
        origin,
      });
      expect(outcome.ok && outcome.route.profileId).toBe('work');
    },
  );

  it.each(['automation', 'loop', 'workflow', 'failover', 'internal'] as const)(
    'still blocks %s inside the same scope — this is not a general re-enable',
    async (origin) => {
      const outcome = await excludedService().resolveRouteForSpawn({
        workingDirectory: '/work/ebrd/repo',
        origin,
      });
      expect(outcome.ok === false && outcome.code).toBe('automation-disallowed');
    },
  );

  it('still blocks a review OUTSIDE any protected enterprise scope', async () => {
    const outcome = await excludedService().resolveRouteForSpawn({
      workingDirectory: '/somewhere/else',
      origin: 'review',
    });
    expect(outcome.ok === false && outcome.code).toBe('automation-disallowed');
  });

  it('does not extend the carve-out to a protected PERSONAL scope', async () => {
    const outcome = await makeService({
      profiles: [profile('personal', { isDefault: true })],
      rules: [{ ...protectedRule, profileId: 'personal' }],
      excluded: true,
    }).resolveRouteForSpawn({ workingDirectory: '/work/ebrd/repo', origin: 'review' });
    expect(outcome.ok === false && outcome.code).toBe('automation-disallowed');
  });
});

describe('CopilotAccountRoutingService.classifyWorkspaceScope', () => {
  const enterprise = profile('work', { accountKind: 'enterprise', scopePolicy: 'matched-only' });
  const rule = (overrides: Partial<CopilotAccountRoutingRule> = {}): CopilotAccountRoutingRule => ({
    id: 'r-work',
    profileId: 'work',
    matcher: { type: 'path-prefix', canonicalPath: '/work/ebrd' },
    isProtected: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  it('reports the enterprise profile for a protected workspace', () => {
    const scope = makeService({ profiles: [enterprise], rules: [rule()] })
      .classifyWorkspaceScope('/work/ebrd/repo');
    expect(scope).toMatchObject({ kind: 'protected', profileId: 'work', accountKind: 'enterprise' });
  });

  it('reports none outside every protected rule', () => {
    const scope = makeService({ profiles: [enterprise], rules: [rule()] })
      .classifyWorkspaceScope('/elsewhere');
    expect(scope.kind).toBe('none');
  });

  it('ignores an unprotected rule — containment follows protection, not mere mapping', () => {
    const scope = makeService({ profiles: [enterprise], rules: [rule({ isProtected: false })] })
      .classifyWorkspaceScope('/work/ebrd/repo');
    expect(scope.kind).toBe('none');
  });

  it('still reports the scope when the seat is excluded from automation', () => {
    // The workspace does not stop being the employer's because their seat is
    // unusable right now — this is why classification must not go through the
    // spawn path.
    const scope = makeService({ profiles: [enterprise], rules: [rule()], excluded: true })
      .classifyWorkspaceScope('/work/ebrd/repo');
    expect(scope.kind).toBe('protected');
  });

  it('reports ambiguous when two protected scopes claim the workspace', () => {
    const scope = makeService({
      profiles: [enterprise, profile('other', { accountKind: 'enterprise' })],
      rules: [rule(), rule({ id: 'r-other', profileId: 'other' })],
    }).classifyWorkspaceScope('/work/ebrd/repo');
    expect(scope).toMatchObject({ kind: 'ambiguous' });
  });

  it('reports ambiguous when a protected rule points at a deleted profile', () => {
    const scope = makeService({ profiles: [profile('personal')], rules: [rule()] })
      .classifyWorkspaceScope('/work/ebrd/repo');
    expect(scope.kind).toBe('ambiguous');
  });

  it('reports none without a working directory', () => {
    expect(makeService().classifyWorkspaceScope(undefined).kind).toBe('none');
  });
});

/**
 * Fail-closed must be SCOPED. An unreadable settings file used to make
 * `classifyWorkspaceScope` return `indeterminate` unconditionally, which the
 * checking policy turns into "no checkers at all" — disabling every ping-pong
 * review and every consensus query for every provider, on machines with no
 * enterprise seat at all. The settings lock can genuinely time out under
 * concurrent writes, so that blast radius was far too wide.
 */
describe('CopilotAccountRoutingService.classifyWorkspaceScope — degraded reads', () => {
  const enterprise = profile('work', { accountKind: 'enterprise', scopePolicy: 'matched-only' });
  const protectedRule: CopilotAccountRoutingRule = {
    id: 'r-work',
    profileId: 'work',
    matcher: { type: 'path-prefix', canonicalPath: '/work/ebrd' },
    isProtected: true,
    createdAt: 1,
    updatedAt: 1,
  };

  function throwingService(reads: Array<() => never | ReturnType<() => {
    copilotAccountProfiles: CopilotAccountProfile[];
    copilotAccountRoutingRules: CopilotAccountRoutingRule[];
  }>>): CopilotAccountRoutingService {
    let call = 0;
    return new CopilotAccountRoutingService({
      readSettings: () => (reads[Math.min(call++, reads.length - 1)] as () => {
        copilotAccountProfiles: CopilotAccountProfile[];
        copilotAccountRoutingRules: CopilotAccountRoutingRule[];
      })(),
      collectRemotes: () => [],
      canonicalize: (path) => path,
      isProviderExcluded: () => false,
      bindingService: bindingService({}),
    });
  }

  it('treats a missing settings manager as unscoped, not as a licence risk', () => {
    // No injected reader, and no Electron userData in the test runner, so
    // `getSettingsManager()` itself throws. Copilot account routing cannot be
    // configured in such a process at all (the `aio review` CLI is the real
    // case), so there is no boundary to protect and checking must stay enabled.
    const service = new CopilotAccountRoutingService({
      collectRemotes: () => [],
      canonicalize: (path) => path,
      isProviderExcluded: () => false,
      bindingService: bindingService({}),
    });
    expect(service.classifyWorkspaceScope('/anything').kind).toBe('none');
  });

  it('fails CLOSED when the very first settings read of the process fails', () => {
    // Cold start: an absent enterprise rule here is ignorance, not evidence. If
    // this returned `none`, one dispatch could check employer code off its seat.
    const service = throwingService([() => { throw new Error('settings lock timeout'); }]);
    expect(service.classifyWorkspaceScope('/anything').kind).toBe('indeterminate');
  });

  it('reports none once a successful read has shown there is no enterprise scope', () => {
    const personalOnly = () => ({
      copilotAccountProfiles: [profile('personal', { isDefault: true })],
      copilotAccountRoutingRules: [],
    });
    const service = throwingService([personalOnly, () => { throw new Error('lock timeout'); }]);

    expect(service.classifyWorkspaceScope('/first').kind).toBe('none');
    // Now the absence of an enterprise rule is an observation, so a later
    // transient failure must not disable checking for every provider.
    expect(service.classifyWorkspaceScope('/second').kind).toBe('none');
  });

  it('reports indeterminate once an enterprise protected rule has been seen', () => {
    const ok = () => ({
      copilotAccountProfiles: [enterprise],
      copilotAccountRoutingRules: [protectedRule],
    });
    const service = throwingService([ok, () => { throw new Error('settings lock timeout'); }]);

    // First read succeeds on a DIFFERENT path, teaching the service that this
    // machine has a licence boundary worth protecting.
    expect(service.classifyWorkspaceScope('/elsewhere').kind).toBe('none');
    expect(service.classifyWorkspaceScope('/never-seen').kind).toBe('indeterminate');
  });

  it('reuses the last authoritative answer for a path it has already classified', () => {
    const ok = () => ({
      copilotAccountProfiles: [enterprise],
      copilotAccountRoutingRules: [protectedRule],
    });
    const service = throwingService([ok, () => { throw new Error('boom'); }]);

    expect(service.classifyWorkspaceScope('/work/ebrd/repo')).toMatchObject({ kind: 'protected' });
    service.invalidate(); // drops the TTL memo, keeps last-known
    expect(service.classifyWorkspaceScope('/work/ebrd/repo')).toMatchObject({ kind: 'protected' });
  });
});
