import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueAccountRules, PlanQueueRouteChoice, PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import {
  PlanQueueRoutingError, resolveRunRouting, routeQueueSpawn, type PlanQueueRoutingDeps,
} from './plan-queue-routing';
import { pickRouteChoice, planQueueRouteUsage, type PlanQueueRouteUsageDeps } from './plan-queue-route-usage';
import type { PlanQueueRun } from './plan-queue.types';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({}) }),
}));

const NONE: PlanQueueAccountRules = { never: [], last: [] };
const rules = (never: PlanQueueAccountRules['never'] = [], last: PlanQueueAccountRules['last'] = []): PlanQueueAccountRules => ({ never, last });
const pool = (id: string, provider: 'claude' | 'codex', extra: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile => ({
  id, provider, label: `Label ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
  priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: false, createdAt: 1, updatedAt: 1, ...extra,
} as ProviderAccountProfile);

function deps(overrides: { saved?: PlanQueueRouting; rules?: PlanQueueAccountRules; pool?: ProviderAccountProfile[]; seat?: string | null } = {}): PlanQueueRoutingDeps {
  return {
    readSaved: () => overrides.saved ?? { workers: [], verifiers: [] },
    readAccountRules: () => overrides.rules ?? NONE,
    poolProfiles: () => overrides.pool ?? [pool('suas', 'claude'), pool('other', 'claude')],
    copilotProfiles: () => [{ id: 'work', label: 'Work seat', automationPolicy: 'allow-routed' } as never],
    isProviderExcluded: () => false,
    defaultProvider: () => null,
    checkerScopeKind: () => 'none',
    copilotProfileFor: () => overrides.seat ?? null,
    listInstalledProviders: async () => ['claude', 'codex', 'copilot'],
  };
}

const run = (routing?: PlanQueueRouting): PlanQueueRun => ({ config: { routing } }) as unknown as PlanQueueRun;
const spawn = (role: string, extra: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig =>
  ({ metadata: { planQueueRunId: 'run-1', planQueueRole: role }, ...extra }) as InstanceCreateConfig;

describe('start-time refusals for the never-use list', () => {
  it('refuses a worker that ticks a never-use account, naming the account', () => {
    const saved: PlanQueueRouting = { workers: [{ provider: 'claude', accountProfileIds: ['suas'] }], verifiers: [] };
    expect(() => resolveRunRouting({}, { workspaceCwd: '/repo' }, deps({ saved, rules: rules([{ provider: 'claude', accountId: 'suas' }]) })))
      .toThrow(new PlanQueueRoutingError('Plan Queue worker: the claude account "Label suas" is on your never-use list. Untick it, or take it off the never-use list on the Plan Queue page.'));
  });

  it('refuses a provider whose every usable account is on the list, even with no account ticked', () => {
    const saved: PlanQueueRouting = { workers: [{ provider: 'claude' }], verifiers: [] };
    const banned = rules([{ provider: 'claude', accountId: 'suas' }, { provider: 'claude', accountId: 'other' }]);
    expect(() => resolveRunRouting({}, { workspaceCwd: '/repo' }, deps({ saved, rules: banned })))
      .toThrow(/every claude account this choice can use is on your never-use list/);
  });

  it('refuses a worker whose folder Copilot seat is on the list, and names the worker choice', () => {
    const saved: PlanQueueRouting = { workers: [{ provider: 'copilot' }], verifiers: [] };
    expect(() => resolveRunRouting({}, { workspaceCwd: '/repo' }, deps({ saved, rules: rules([{ provider: 'copilot', accountId: 'work' }]), seat: 'work' })))
      .toThrow(/this folder's Copilot account \("Work seat"\) is on your never-use list/);
  });

  it('lets a run start when the list is empty for its accounts', () => {
    const saved: PlanQueueRouting = { workers: [{ provider: 'claude', accountProfileIds: ['other'] }], verifiers: [] };
    expect(resolveRunRouting({}, { workspaceCwd: '/repo' }, deps({ saved, rules: rules([{ provider: 'claude', accountId: 'suas' }]) })).routing.workers)
      .toEqual([{ provider: 'claude', accountProfileIds: ['other'] }]);
  });
});

describe('a session with no provider', () => {
  it('refuses a run that has no worker provider while a never-use rule is set', () => {
    expect(() => resolveRunRouting({}, { workspaceCwd: '/repo' }, deps({ rules: rules([{ provider: 'claude', accountId: 'suas' }]) })))
      .toThrow(/has no worker provider, so the queue cannot apply your never-use list/);
  });

  it('refuses a spawn with no provider while a never-use rule is set', () => {
    const config = spawn('worker');
    expect(() => routeQueueSpawn(config, () => run({ workers: [], verifiers: [] }), null, () => false, rules([{ provider: 'claude', accountId: 'suas' }])))
      .toThrow(/has no worker provider/);
  });
});

describe('the starting session\'s account', () => {
  it('is not inherited when it is on the never-use list, and the run says so', () => {
    const parent = { provider: 'claude', accountProfileId: 'suas', currentModel: 'claude-x' };
    const resolved = resolveRunRouting(parent, undefined, deps({ rules: rules([{ provider: 'claude', accountId: 'suas' }]) }));
    expect(resolved.routing.workers).toEqual([{ provider: 'claude', model: 'claude-x' }]);
    expect(resolved.accountNotes).toEqual([
      'The starting session\'s account "Label suas" is on your never-use list, so the run picks its own account.',
    ]);
  });

  it('is not inherited when it is on the use-last list either', () => {
    const resolved = resolveRunRouting({ provider: 'claude', accountProfileId: 'suas' }, undefined, deps({ rules: rules([], [{ provider: 'claude', accountId: 'suas' }]) }));
    expect(resolved.routing.workers[0]).not.toHaveProperty('accountProfileIds');
    expect(resolved.accountNotes[0]).toContain('use-last list');
  });

  it('is inherited as before when no rule names it', () => {
    const resolved = resolveRunRouting({ provider: 'claude', accountProfileId: 'other' }, undefined, deps());
    expect(resolved.routing.workers).toEqual([{ provider: 'claude', accountProfileIds: ['other'] }]);
    expect(resolved.accountNotes).toEqual([]);
  });
});

describe('routeQueueSpawn account preferences', () => {
  const getRun = () => run({ workers: [{ provider: 'claude' }], verifiers: [] });

  it('gives a worker the never-use and use-last ids for its provider, from the live lists', () => {
    const r = rules([{ provider: 'claude', accountId: 'suas' }, { provider: 'copilot', accountId: 'work' }], [{ provider: 'claude', accountId: 'other' }]);
    const routed = routeQueueSpawn(spawn('worker', { provider: 'claude' }), getRun, { provider: 'claude' }, () => false, r);
    expect(routed.accountPreferences).toEqual({ avoid: ['suas'], last: ['other'] });
  });

  it('gives a checker the lists for its own provider too', () => {
    const r = rules([{ provider: 'codex', accountId: 'pro-2' }]);
    const routed = routeQueueSpawn(spawn('verifier', { provider: 'codex' }), getRun, null, () => false, r);
    expect(routed.accountPreferences).toEqual({ avoid: ['pro-2'], last: [] });
  });

  it('drops a stale copy left on the config once the lists no longer name the provider', () => {
    const config = spawn('worker', { provider: 'claude', accountPreferences: { avoid: ['old'], last: [] } });
    const routed = routeQueueSpawn(config, getRun, { provider: 'claude' }, () => false, NONE);
    expect(routed).not.toHaveProperty('accountPreferences');
    expect(config.accountPreferences).toEqual({ avoid: ['old'], last: [] });
  });

  it('gives a triage retry the lists too', () => {
    const config = spawn('triage', { provider: 'claude', metadata: { planQueueRunId: 'run-1', planQueueRole: 'triage', planQueueTriageRetry: true } });
    const routed = routeQueueSpawn(config, getRun, null, () => false, rules([{ provider: 'claude', accountId: 'suas' }]));
    expect(routed.accountPreferences).toEqual({ avoid: ['suas'], last: [] });
  });
});

describe('ranked choices: use-last comes last across the whole list', () => {
  const claudeLast: PlanQueueRouteChoice = { provider: 'claude', accountProfileIds: ['suas'] };
  const codex: PlanQueueRouteChoice = { provider: 'codex' };

  it('picks an ordinary choice before a use-last one, even when the use-last one comes first', async () => {
    const usage = vi.fn(async (choice: PlanQueueRouteChoice, _origin: string, options: { allowLast: boolean }) => ({
      usable: choice.provider === 'codex' || options.allowLast, resumeAt: null,
    }));
    const picked = await pickRouteChoice([claudeLast, codex], 'automation', usage);
    expect(picked).toMatchObject({ index: 1, usable: true, choice: codex });
  });

  it('uses the use-last choice when nothing else has usage left', async () => {
    const usage = vi.fn(async (choice: PlanQueueRouteChoice, _origin: string, options: { allowLast: boolean }) => ({
      usable: choice.provider === 'claude' && options.allowLast, resumeAt: null,
    }));
    expect(await pickRouteChoice([codex, claudeLast], 'automation', usage)).toMatchObject({ index: 1, usable: true });
  });
});

describe('planQueueRouteUsage with account rules', () => {
  function usageDeps(r: PlanQueueAccountRules, route: { profileId: string } = { profileId: 'other' }) {
    const previewAccountRoute = vi.fn(async () => ({
      outcome: { ok: true as const, route: { provider: 'claude' as const, profileId: route.profileId, source: 'default' as const, executionNodeId: 'local' } },
      considered: [],
    }));
    const base: PlanQueueRouteUsageDeps = {
      previewAccountRoute,
      ledger: { getActive: () => null, getParkedSince: () => new Map() } as unknown as PlanQueueRouteUsageDeps['ledger'],
      spawnModel: async () => null,
      quotaEvidence: () => null,
      providerQuota: () => null,
      accountRules: () => r,
      copilotProfileFor: () => null,
      now: () => 1,
    };
    return { base, previewAccountRoute };
  }

  it('asks the pool to avoid never-use accounts and to use last the use-last ones', async () => {
    const { base, previewAccountRoute } = usageDeps(rules([{ provider: 'claude', accountId: 'suas' }], [{ provider: 'claude', accountId: 'other' }]));
    await planQueueRouteUsage({ provider: 'claude' }, 'automation', { allowLast: true }, base);
    expect(previewAccountRoute).toHaveBeenCalledWith(expect.objectContaining({ avoid: ['suas'], useLast: ['other'] }));
  });

  it('treats a use-last route as unavailable on the first pass and usable on the second', async () => {
    const { base } = usageDeps(rules([], [{ provider: 'claude', accountId: 'other' }]), { profileId: 'other' });
    expect(await planQueueRouteUsage({ provider: 'claude' }, 'automation', { allowLast: false }, base)).toEqual({ usable: false, resumeAt: null });
    expect(await planQueueRouteUsage({ provider: 'claude' }, 'automation', { allowLast: true }, base)).toEqual({ usable: true, resumeAt: null });
  });

  it('treats a Copilot seat on the never-use list as having no usage, and a use-last one only on the second pass', async () => {
    const { base } = usageDeps(rules([{ provider: 'copilot', accountId: 'work' }]));
    expect(await planQueueRouteUsage({ provider: 'copilot', copilotProfileId: 'work' }, 'automation', { allowLast: true }, base)).toEqual({ usable: false, resumeAt: null });
    const lastDeps = usageDeps(rules([], [{ provider: 'copilot', accountId: 'work' }]));
    expect(await planQueueRouteUsage({ provider: 'copilot', copilotProfileId: 'work' }, 'automation', { allowLast: false }, lastDeps.base)).toEqual({ usable: false, resumeAt: null });
  });

  it('uses the folder\'s Copilot seat when a Copilot choice names no account', async () => {
    const { base } = usageDeps(NONE);
    const seated = { ...base, copilotProfileFor: () => 'work' };
    const banned = { ...seated, accountRules: () => rules([{ provider: 'copilot', accountId: 'work' }]) };
    expect(await planQueueRouteUsage({ provider: 'copilot' }, 'automation', { allowLast: true, workingDirectory: '/repo' }, banned))
      .toEqual({ usable: false, resumeAt: null });
  });
});
