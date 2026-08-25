import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CopilotAccountBindingStatus,
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
  CopilotInvocationOrigin,
} from '../../../shared/types/copilot-account.types';
import type { GitHubRemoteIdentity } from '../../vcs/remotes/github-remote-identity';
import type { CopilotAccountBindingService } from './copilot-account-binding-service';
import { CopilotAccountRoutingService } from './copilot-account-routing-service';
import { _setCopilotAccountEventSinkForTesting } from './copilot-account-events';

/**
 * Spec §12 / §19.4. Two independent controls, in a fixed order:
 *
 *   1. `providersExcludedFromAutomation` — the coarse operator override. When
 *      it lists `copilot`, NO account is selected automatically.
 *   2. per-profile `automationPolicy` — which accounts an automatic surface may
 *      use once Copilot itself is eligible.
 *
 * And the invariant that keeps them honest: a blocked account route makes
 * Copilot unavailable for that invocation. It never selects a different Copilot
 * account.
 */

const ENTERPRISE_OWNER = 'acme';
const PERSONAL_OWNER = 'octocat';

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

function ownerRule(id: string, profileId: string, owner: string): CopilotAccountRoutingRule {
  return {
    id,
    profileId,
    matcher: { type: 'owner', host: 'github.com', owner },
    isProtected: profileId === 'enterprise',
    createdAt: 1,
    updatedAt: 1,
  };
}

function remote(owner: string): GitHubRemoteIdentity {
  return {
    remoteName: 'origin',
    host: 'github.com',
    owner,
    repo: 'repo',
    displayPath: `${owner}/repo`,
  };
}

function bindings(
  states: Record<string, CopilotAccountBindingStatus['state']> = {},
): CopilotAccountBindingService {
  return {
    checkBinding: vi.fn(async (target: CopilotAccountProfile, nodeId: string) => ({
      profileId: target.id,
      nodeId,
      state: states[target.id] ?? 'authenticated',
      checkedAt: 1,
    })),
    invalidate: vi.fn(),
  } as unknown as CopilotAccountBindingService;
}

interface Setup {
  profiles: CopilotAccountProfile[];
  rules?: CopilotAccountRoutingRule[];
  remotesByCwd?: Record<string, GitHubRemoteIdentity[]>;
  excluded?: boolean;
  bindingStates?: Record<string, CopilotAccountBindingStatus['state']>;
}

function makeService(setup: Setup): CopilotAccountRoutingService {
  return new CopilotAccountRoutingService({
    readSettings: () => ({
      copilotAccountProfiles: setup.profiles,
      copilotAccountRoutingRules: setup.rules ?? [],
    }),
    collectRemotes: (cwd) => setup.remotesByCwd?.[cwd] ?? [],
    canonicalize: (path) => path,
    isProviderExcluded: () => setup.excluded ?? false,
    bindingService: bindings(setup.bindingStates),
  });
}

const AUTOMATIC_ORIGINS: CopilotInvocationOrigin[] = [
  'automation',
  'review',
  'verification',
  'loop',
  'workflow',
  'consensus',
  'failover',
  'internal',
];

beforeEach(() => {
  _setCopilotAccountEventSinkForTesting(() => undefined);
});

describe('coarse providersExcludedFromAutomation override', () => {
  it('blocks every automatic origin regardless of per-profile policy', async () => {
    const service = makeService({
      profiles: [profile('personal', { isDefault: true, automationPolicy: 'allow-routed' })],
      excluded: true,
    });
    for (const origin of AUTOMATIC_ORIGINS) {
      const outcome = await service.resolveRouteForSpawn({ workingDirectory: '/w', origin });
      expect(outcome.ok, origin).toBe(false);
      expect(outcome.ok === false && outcome.code, origin).toBe('automation-disallowed');
    }
  });

  it('still allows an explicit interactive session', async () => {
    const outcome = await makeService({
      profiles: [profile('personal', { isDefault: true })],
      excluded: true,
    }).resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' });
    expect(outcome.ok).toBe(true);
  });

  it('is evaluated before per-profile policy, so the failure names the provider not a profile', async () => {
    const outcome = await makeService({
      profiles: [profile('personal', { isDefault: true, automationPolicy: 'disabled' })],
      excluded: true,
    }).resolveRouteForSpawn({ workingDirectory: '/w', origin: 'loop' });
    expect(outcome.ok === false && outcome.detail).toContain('never auto-pick');
    expect(outcome.ok === false && outcome.profileId).toBeUndefined();
  });
});

describe('per-profile automationPolicy', () => {
  it('allow-routed permits every automatic origin after an unambiguous route', async () => {
    const service = makeService({
      profiles: [profile('personal', { isDefault: true, automationPolicy: 'allow-routed' })],
    });
    for (const origin of AUTOMATIC_ORIGINS) {
      const outcome = await service.resolveRouteForSpawn({ workingDirectory: '/w', origin });
      expect(outcome.ok, origin).toBe(true);
    }
  });

  it('manual-only permits interactive and blocks every automatic origin', async () => {
    const service = makeService({
      profiles: [profile('personal', { isDefault: true, automationPolicy: 'manual-only' })],
    });
    expect(
      (await service.resolveRouteForSpawn({ workingDirectory: '/w', origin: 'interactive' })).ok,
    ).toBe(true);
    for (const origin of AUTOMATIC_ORIGINS) {
      const outcome = await service.resolveRouteForSpawn({ workingDirectory: '/w', origin });
      expect(outcome.ok === false && outcome.code, origin).toBe('automation-disallowed');
    }
  });

  it('disabled blocks new invocations of every kind, including interactive', async () => {
    const service = makeService({
      profiles: [profile('personal', { isDefault: true, automationPolicy: 'disabled' })],
    });
    for (const origin of ['interactive', ...AUTOMATIC_ORIGINS] as CopilotInvocationOrigin[]) {
      const outcome = await service.resolveRouteForSpawn({ workingDirectory: '/w', origin });
      expect(outcome.ok === false && outcome.code, origin).toBe('automation-disallowed');
    }
  });
});

describe('concurrent enterprise and personal sessions stay pinned', () => {
  const setup: Setup = {
    profiles: [
      profile('personal', { isDefault: true }),
      profile('enterprise', { accountKind: 'enterprise', scopePolicy: 'matched-only' }),
    ],
    rules: [
      ownerRule('r-ent', 'enterprise', ENTERPRISE_OWNER),
      ownerRule('r-per', 'personal', PERSONAL_OWNER),
    ],
    remotesByCwd: {
      '/work/enterprise': [remote(ENTERPRISE_OWNER)],
      '/work/personal': [remote(PERSONAL_OWNER)],
    },
  };

  it('resolves each workspace to its own account under concurrent load', async () => {
    const service = makeService(setup);
    // 20 interleaved resolutions; a shared-mutable-state bug (the exact hazard
    // that rules out `/user switch`) would show up as a crossed result here.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        service
          .resolveRouteForSpawn({
            workingDirectory: index % 2 === 0 ? '/work/enterprise' : '/work/personal',
            origin: 'loop',
          })
          .then((outcome) => ({
            index,
            profileId: outcome.ok ? outcome.route.profileId : `blocked:${outcome.code}`,
          })),
      ),
    );
    for (const result of results) {
      expect(result.profileId, `iteration ${result.index}`).toBe(
        result.index % 2 === 0 ? 'enterprise' : 'personal',
      );
    }
  });

  it('routes the same two workspaces consistently across repeated passes', async () => {
    const service = makeService(setup);
    for (let pass = 0; pass < 3; pass += 1) {
      const enterprise = await service.resolveRouteForSpawn({
        workingDirectory: '/work/enterprise',
        origin: 'review',
      });
      const personal = await service.resolveRouteForSpawn({
        workingDirectory: '/work/personal',
        origin: 'review',
      });
      expect(enterprise.ok && enterprise.route.profileId).toBe('enterprise');
      expect(personal.ok && personal.route.profileId).toBe('personal');
    }
  });
});

describe('a blocked account route never falls back to another Copilot account', () => {
  it('reports the blocked profile and never names the default', async () => {
    const outcome = await makeService({
      profiles: [
        profile('personal', { isDefault: true }),
        profile('enterprise', {
          accountKind: 'enterprise',
          scopePolicy: 'matched-only',
          automationPolicy: 'manual-only',
        }),
      ],
      rules: [ownerRule('r-ent', 'enterprise', ENTERPRISE_OWNER)],
      remotesByCwd: { '/work/enterprise': [remote(ENTERPRISE_OWNER)] },
    }).resolveRouteForSpawn({ workingDirectory: '/work/enterprise', origin: 'loop' });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.profileId).toBe('enterprise');
    // The personal default is a perfectly healthy Copilot account and is
    // deliberately NOT offered: cross-account fallback is the failure mode.
    expect(JSON.stringify(outcome)).not.toContain('personal');
  });

  it('does not retry through another account after an authentication failure', async () => {
    const outcome = await makeService({
      profiles: [
        profile('personal', { isDefault: true }),
        profile('enterprise', { accountKind: 'enterprise', scopePolicy: 'matched-only' }),
      ],
      rules: [ownerRule('r-ent', 'enterprise', ENTERPRISE_OWNER)],
      remotesByCwd: { '/work/enterprise': [remote(ENTERPRISE_OWNER)] },
      bindingStates: { enterprise: 'unauthenticated' },
    }).resolveRouteForSpawn({ workingDirectory: '/work/enterprise', origin: 'automation' });

    expect(outcome.ok === false && outcome.code).toBe('profile-unauthenticated');
    expect(outcome.ok === false && outcome.profileId).toBe('enterprise');
  });
});
