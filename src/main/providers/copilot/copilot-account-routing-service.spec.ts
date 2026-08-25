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
