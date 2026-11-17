/**
 * Only the providers James allowed see a Linear run's tickets: the list, the three checks, the limited checker choice.
 * No session is ever created in these tests: the instance port is a stand-in that counts `createInstance` calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ planQueueAccountRules: { never: [], last: [] }, providerAccountProfiles: [], copilotAccountProfiles: [], copilotAccountRoutingRules: [], planQueueLinearTeams: [] }),
  }),
}));
vi.mock('../providers/automation-provider-exclusions', () => ({
  filterProvidersForAutomation: (providers: string[]) => providers,
  isProviderExcludedFromAutomation: () => false,
}));

import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { selectCurrentQueueVerifier } from './plan-queue-checker-routing';
import type { PlanQueueFlowHost, PlanQueueInstancePort } from './plan-queue-host';
import {
  _setLinearProviderPolicyForTesting, excludedProvidersForRun, LinearProviderPolicy, PlanQueueProviderNotAllowed,
  type LinearRunTeam,
} from './plan-queue-linear-providers';
import { changeRunRouting } from './plan-queue-run-routing-change';
import { planQueueProviderChoices, type PlanQueueRoutingDeps } from './plan-queue-routing';
import { spawnQueueInstance } from './plan-queue-spawn';
import { newPlanQueueItem } from './plan-queue-state';
import { selectPlanQueueVerifier } from './plan-queue-verifier-select';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const COM: LinearRunTeam = { teamId: 'team-com', teamKey: 'COM' };
const ORC: LinearRunTeam = { teamId: 'team-orc', teamKey: 'ORC' };
const labelOf = (id: string): string => planQueueProviderChoices().find((choice) => choice.id === id)!.label;
const refusal = (provider: string, key: string): RegExp => new RegExp(`^${labelOf(provider)} is not allowed to see tickets from the ${key} team\\.`);

let saved: { teamId: string; providers: string[] }[];
let runTeams: LinearRunTeam[];
let policy: LinearProviderPolicy;

beforeEach(() => {
  saved = [{ teamId: COM.teamId, providers: ['claude', 'codex'] }];
  runTeams = [COM];
  policy = new LinearProviderPolicy({ readTeams: () => saved, teamsOfRun: () => runTeams });
  _setLinearProviderPolicyForTesting(policy);
});
afterEach(() => _setLinearProviderPolicyForTesting(null));

describe('the list for a run', () => {
  it('is the providers every team with a ticket in the run allows, not the union', () => {
    saved = [
      { teamId: COM.teamId, providers: ['claude', 'codex', 'copilot'] },
      { teamId: ORC.teamId, providers: ['codex', 'copilot', 'cursor'] },
    ];
    expect(policy.allowedProviders([COM])).toEqual(['claude', 'codex', 'copilot']);
    expect(policy.allowedProviders([COM, ORC])).toEqual(['codex', 'copilot']);
  });

  it('is empty for a team with no saved entry and for a team whose list is empty', () => {
    saved = [{ teamId: COM.teamId, providers: [] }];
    expect(policy.allowedProviders([COM])).toEqual([]);
    expect(policy.allowedProviders([ORC])).toEqual([]);
    expect(() => policy.assertProviderAllowed([COM], 'claude')).toThrow(PlanQueueProviderNotAllowed);
    expect(() => policy.assertProviderAllowed([ORC], 'claude')).toThrow(refusal('claude', 'ORC'));
  });

  it('is empty when the run has no team, and refuses with its own sentence', () => {
    expect(policy.allowedProviders([])).toEqual([]);
    expect(() => policy.assertProviderAllowed([], 'claude')).toThrow('This Linear run has no tickets, so no provider is allowed for it.');
  });

  it('compares through the provider ids the routing uses, so openai is codex and gemini is antigravity', () => {
    saved = [{ teamId: COM.teamId, providers: ['codex', 'antigravity'] }];
    expect(() => policy.assertProviderAllowed([COM], 'openai')).not.toThrow();
    expect(() => policy.assertProviderAllowed([COM], ' Codex ')).not.toThrow();
    expect(() => policy.assertProviderAllowed([COM], 'gemini')).not.toThrow();
    expect(() => policy.assertProviderAllowed([COM], 'claude')).toThrow(PlanQueueProviderNotAllowed);
  });

  it('is read live each time: a change James saves counts at the next question', () => {
    expect(policy.allowedProviders([COM])).toEqual(['claude', 'codex']);
    saved = [{ teamId: COM.teamId, providers: ['codex'] }];
    expect(policy.allowedProviders([COM])).toEqual(['codex']);
  });

  it('refuses in fixed words that name the provider label and the team key, and nothing else', () => {
    saved = [{ teamId: COM.teamId, providers: ['codex'] }, { teamId: ORC.teamId, providers: ['codex', 'claude'] }];
    let message = '';
    try { policy.assertProviderAllowed([ORC, COM], 'claude'); } catch (error) { message = (error as Error).message; }
    expect(message).toBe(`${labelOf('claude')} is not allowed to see tickets from the COM team. Choose another provider, or allow this one for the COM team on the Plan Queue page.`);
  });

  it('refuses `auto`, an empty name and no provider, naming the first team key', () => {
    for (const provider of ['auto', 'AUTO', '', '  ', undefined, null]) {
      expect(() => policy.assertProviderAllowed([ORC, COM], provider)).toThrow(/^This session has no named provider.*the COM team\./);
    }
  });
});

describe('when routing is chosen or changed', () => {
  const parent = { provider: 'claude' };
  const routing = (value: Partial<PlanQueueRouting>): PlanQueueRouting => ({ workers: [], verifiers: [], ...value });

  it('accepts a routing whose every worker, step-up and checker choice is on the list', () => {
    expect(() => policy.assertRoutingAllowed([COM], routing({ workers: [{ provider: 'claude' }, { provider: 'codex' }], stepUp: { provider: 'codex' }, verifiers: [{ provider: 'codex' }] }), parent)).not.toThrow();
  });

  it.each([
    ['a worker choice', { workers: [{ provider: 'claude' }, { provider: 'cursor' }] }, 'cursor'],
    ['the step-up choice', { workers: [{ provider: 'claude' }], stepUp: { provider: 'copilot' } }, 'copilot'],
    ['a checker choice', { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'codex' }, { provider: 'grok' }] }, 'grok'],
  ] as const)('refuses %s that is not on the list', (_name, value, provider) => {
    expect(() => policy.assertRoutingAllowed([COM], routing(value as unknown as Partial<PlanQueueRouting>), parent)).toThrow(refusal(provider, 'COM'));
  });

  it('uses the starting session\'s provider when there is no worker choice, so that provider must be on the list', () => {
    expect(() => policy.assertRoutingAllowed([COM], routing({}), { provider: 'codex' })).not.toThrow();
    expect(() => policy.assertRoutingAllowed([COM], routing({}), { provider: 'cursor' })).toThrow(refusal('cursor', 'COM'));
    expect(() => policy.assertRoutingAllowed([COM], routing({}), {})).toThrow(/no named provider/);
    expect(() => policy.assertRoutingAllowed([COM], routing({}), { provider: 'auto' })).toThrow(/no named provider/);
  });

  it('does not look at the starting session when workers are chosen', () => {
    expect(() => policy.assertRoutingAllowed([COM], routing({ workers: [{ provider: 'codex' }] }), { provider: 'cursor' })).not.toThrow();
  });

  it('leaves automatic checker choice to the exclusions', () => {
    expect(() => policy.assertRoutingAllowed([COM], routing({ workers: [{ provider: 'claude' }], verifiers: [] }), parent)).not.toThrow();
  });
});

describe('automatic checker choice', () => {
  it('leaves out every provider the list does not hold, and keeps the listed ones', () => {
    const everyone = planQueueProviderChoices().map((choice) => choice.id);
    const left = policy.checkerExclusions([COM]);
    expect(left.sort()).toEqual(everyone.filter((id) => id !== 'claude' && id !== 'codex').sort());
    expect(left).not.toContain('claude');
    expect(left).not.toContain('codex');
  });

  it('leaves out every provider when the list is empty', () => {
    saved = [];
    expect(policy.checkerExclusions([COM]).sort()).toEqual(planQueueProviderChoices().map((choice) => choice.id).sort());
  });

  it('never returns a provider that is not on the list, whatever is installed and whichever provider did the work', async () => {
    saved = [{ teamId: COM.teamId, providers: ['claude', 'codex', 'copilot'] }];
    const excludedProviders = policy.checkerExclusions([COM]);
    const allowed = new Set(policy.allowedProviders([COM]));
    const installed = planQueueProviderChoices().map((choice) => choice.id);
    for (const workerProvider of installed) {
      const result = await selectPlanQueueVerifier(
        { workerProvider, workingDirectory: '/repo', excludedProviders },
        { listInstalledProviders: async () => installed, classifyScope: () => ({ kind: 'open' }) as never, routeUsage: async () => ({ usable: true, resumeAt: null }), resolveProviderModel: () => undefined },
      );
      if (result.ok) expect(allowed.has(result.choice.provider)).toBe(true);
    }
  });

  it('is asked for by the queue: selection receives the exclusions with a repair run\'s own frozen ones', async () => {
    const run = ticketsRun({ capabilityRepairExcludedProviders: ['grok'] });
    expect(excludedProvidersForRun(run)).toEqual(expect.arrayContaining(['grok', 'cursor', 'copilot']));
    expect(excludedProvidersForRun(run)).not.toContain('claude');
    const selectVerifier = vi.fn().mockResolvedValue({ ok: true, choice: { provider: 'codex' } });
    const host = { getRun: () => run, instances: { getInstance: () => undefined }, selectVerifier } as unknown as PlanQueueFlowHost;
    const item: PlanQueueItem = { ...newPlanQueueItem('item', run.id, 'linear:abc', 1, { workerInstanceId: 'gone' }), workerProvider: 'claude' };
    await selectCurrentQueueVerifier(host, item);
    expect(selectVerifier.mock.calls[0]![0].excludedProviders).toEqual(excludedProvidersForRun(run));
  });

  it('leaves a plans run exactly as it was', () => {
    expect(excludedProvidersForRun({ ...ticketsRun(), kind: 'plans' })).toBeUndefined();
    expect(excludedProvidersForRun({ ...ticketsRun({ capabilityRepairExcludedProviders: ['grok'] }), kind: 'plans' })).toEqual(['grok']);
  });

  it('turns a failure to read the run\'s teams into a refusal with the reason, so the item parks instead of hanging', async () => {
    _setLinearProviderPolicyForTesting(new LinearProviderPolicy({ readTeams: () => saved, teamsOfRun: () => { throw new Error('table unavailable'); } }));
    const run = ticketsRun();
    const selectVerifier = vi.fn();
    const host = { getRun: () => run, instances: { getInstance: () => undefined }, selectVerifier } as unknown as PlanQueueFlowHost;
    const item: PlanQueueItem = newPlanQueueItem('item', run.id, 'linear:abc', 1, { workerInstanceId: 'gone' });
    await expect(selectCurrentQueueVerifier(host, item)).resolves.toMatchObject({ selection: { ok: false, reason: 'could not choose a checker: table unavailable' } });
    expect(selectVerifier).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// When any session is created
// ---------------------------------------------------------------------------------------------------------------------

function ticketsRun(config: Partial<PlanQueueRun['config']> = {}): PlanQueueRun {
  return {
    id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'tickets', workspaceCwd: '/queue-test', status: 'running',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.tickets, routing: { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'codex' }], stepUp: { provider: 'codex' } }, ...config },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null,
  };
}

describe('when any session is created', () => {
  let run: PlanQueueRun;
  let instances: PlanQueueInstancePort;
  let item: PlanQueueItem | null;
  const spawnHost = (extra: Record<string, unknown> = {}) => ({
    ready: Promise.resolve(), instances, getRun: () => run, getItem: () => item, clearWorkerSession: vi.fn(),
    isShuttingDown: () => false, userCloseEpoch: () => 0, readAccountRules: () => ({ never: [], last: [] }),
    isProviderExcluded: () => false, routeUsage: async () => ({ usable: true, resumeAt: null }), ...extra,
  });
  const metadata = (role: string, more: Record<string, unknown> = {}) => ({ planQueueRunId: 'run', planQueueRole: role, planQueueItemId: 'item', ...more });
  const config = (role: string, provider?: string, more: Record<string, unknown> = {}): InstanceCreateConfig =>
    ({ workingDirectory: '/queue-test', ...(provider ? { provider: provider as InstanceCreateConfig['provider'] } : {}), metadata: metadata(role, more) });

  beforeEach(() => {
    run = ticketsRun();
    item = null;
    instances = {
      createInstance: vi.fn(async () => ({ id: 'created' })), terminateInstance: vi.fn(async () => undefined),
      restartFreshInstance: vi.fn(async () => undefined), sendInput: vi.fn(async () => undefined),
      getInstance: vi.fn(), getAllInstances: () => [],
    };
  });

  /** One role: a provider that is not on the list is refused and nothing is created; a listed one is created. */
  const roles: { name: string; refused: () => Promise<unknown>; listed: () => Promise<unknown>; setUp?: () => void }[] = [
    {
      name: 'triage',
      setUp: () => { run.config.routing = { workers: [{ provider: 'cursor' }], verifiers: [] }; },
      refused: () => spawnQueueInstance(config('triage'), spawnHost()),
      listed: () => { run.config.routing = { workers: [{ provider: 'codex' }], verifiers: [] }; return spawnQueueInstance(config('triage'), spawnHost()); },
    },
    {
      name: 'worker',
      setUp: () => { run.config.routing = { workers: [{ provider: 'cursor' }], verifiers: [] }; },
      refused: () => spawnQueueInstance(config('worker'), spawnHost()),
      listed: () => { run.config.routing = { workers: [{ provider: 'codex' }], verifiers: [] }; return spawnQueueInstance(config('worker'), spawnHost()); },
    },
    {
      name: 'step-up worker',
      setUp: () => { run.config.routing = { workers: [{ provider: 'claude' }], verifiers: [], stepUp: { provider: 'cursor' } }; },
      refused: () => spawnQueueInstance(config('worker', undefined, { planQueueSteppedUp: true }), spawnHost()),
      listed: () => { run.config.routing = { workers: [{ provider: 'claude' }], verifiers: [], stepUp: { provider: 'codex' } }; return spawnQueueInstance(config('worker', undefined, { planQueueSteppedUp: true }), spawnHost()); },
    },
    {
      name: 'checker',
      refused: () => spawnQueueInstance(config('verifier', 'cursor'), spawnHost()),
      listed: () => spawnQueueInstance(config('verifier', 'codex'), spawnHost()),
    },
  ];

  it.each(roles.map((role) => [role.name, role] as const))('a %s on a provider that is not on the list is refused and no session is created', async (_name, role) => {
    role.setUp?.();
    const error = await role.refused().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanQueueProviderNotAllowed);
    expect((error as Error).message).toMatch(refusal('cursor', 'COM'));
    expect(instances.createInstance).not.toHaveBeenCalled();
    expect(instances.terminateInstance).not.toHaveBeenCalled();
  });

  it.each(roles.map((role) => [role.name, role] as const))('a %s on a listed provider is created', async (_name, role) => {
    await role.listed();
    expect(instances.createInstance).toHaveBeenCalledTimes(1);
    expect(instances.createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex' }));
  });

  it('a triage retry, which keeps the checker already chosen, is checked too', async () => {
    await expect(spawnQueueInstance(config('triage', 'cursor', { planQueueTriageRetry: true }), spawnHost())).rejects.toBeInstanceOf(PlanQueueProviderNotAllowed);
    expect(instances.createInstance).not.toHaveBeenCalled();
    await spawnQueueInstance(config('triage', 'codex', { planQueueTriageRetry: true }), spawnHost());
    expect(instances.createInstance).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider of `auto` and no provider for a Linear run, and still accepts them for a plans run', async () => {
    run.config.routing = { workers: [], verifiers: [] };
    run.workerProvider = null;
    await expect(spawnQueueInstance(config('worker'), spawnHost())).rejects.toThrow(/no named provider/);
    await expect(spawnQueueInstance(config('worker', 'auto'), spawnHost())).rejects.toThrow(/no named provider/);
    await expect(spawnQueueInstance(config('verifier', 'auto'), spawnHost())).rejects.toBeInstanceOf(PlanQueueProviderNotAllowed);
    await expect(spawnQueueInstance(config('verifier'), spawnHost())).rejects.toBeInstanceOf(PlanQueueProviderNotAllowed);
    expect(instances.createInstance).not.toHaveBeenCalled();

    run = { ...run, kind: 'plans' };
    await spawnQueueInstance(config('verifier', 'auto'), spawnHost());
    await spawnQueueInstance(config('verifier'), spawnHost());
    await spawnQueueInstance(config('worker'), spawnHost());
    expect(instances.createInstance).toHaveBeenCalledTimes(3);
  });

  it('a run with tickets from two teams uses only providers both teams allow', async () => {
    saved = [{ teamId: COM.teamId, providers: ['claude', 'codex'] }, { teamId: ORC.teamId, providers: ['codex'] }];
    runTeams = [COM, ORC];
    run.config.routing = { workers: [{ provider: 'claude' }], verifiers: [] };
    await expect(spawnQueueInstance(config('worker'), spawnHost())).rejects.toThrow(refusal('claude', 'ORC'));
    expect(instances.createInstance).not.toHaveBeenCalled();
    run.config.routing = { workers: [{ provider: 'codex' }], verifiers: [] };
    await spawnQueueInstance(config('worker'), spawnHost());
    expect(instances.createInstance).toHaveBeenCalledTimes(1);
  });

  it('a team\'s list emptied mid-run refuses the next session and leaves the one already running alone', async () => {
    await spawnQueueInstance(config('worker'), spawnHost());
    expect(instances.createInstance).toHaveBeenCalledTimes(1);
    saved = [{ teamId: COM.teamId, providers: [] }];
    await expect(spawnQueueInstance(config('worker'), spawnHost())).rejects.toBeInstanceOf(PlanQueueProviderNotAllowed);
    await expect(spawnQueueInstance(config('verifier', 'codex'), spawnHost())).rejects.toBeInstanceOf(PlanQueueProviderNotAllowed);
    expect(instances.createInstance).toHaveBeenCalledTimes(1);
    expect(instances.terminateInstance).not.toHaveBeenCalled();
    expect(instances.sendInput).not.toHaveBeenCalled();
  });

  it('a list that changes while the session is being prepared is read again before the session is created', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const routeUsage = vi.fn(async () => { await gate; return { usable: true, resumeAt: null }; });
    const pending = spawnQueueInstance(config('worker'), spawnHost({ routeUsage }));
    await vi.waitFor(() => expect(routeUsage).toHaveBeenCalled());
    saved = [{ teamId: COM.teamId, providers: ['codex'] }];
    release();
    await expect(pending).rejects.toThrow(refusal('claude', 'COM'));
    expect(instances.createInstance).not.toHaveBeenCalled();
  });

  it('set-routing landing while a session is prepared: created on the old routing or refused under the new, never on a provider neither allows', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const routeUsage = vi.fn(async () => {
      if (first) { first = false; await gate; }
      return { usable: true, resumeAt: null };
    });
    const pending = spawnQueueInstance(config('worker'), spawnHost({ routeUsage }));
    await vi.waitFor(() => expect(routeUsage).toHaveBeenCalledTimes(1));
    // James moves the run to codex (allowed) while the first usage check is waiting; the spawn starts again on it.
    run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'codex' }], verifiers: [] } } };
    release();
    await pending;
    expect(instances.createInstance).toHaveBeenCalledTimes(1);
    expect(instances.createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex' }));
  });

  it('after a restart, a worker\'s conversation is reopened only if its provider is still on the list', async () => {
    item = {
      ...newPlanQueueItem('item', 'run', 'linear:abc', 1),
      workerSession: { provider: 'claude', model: null, accountProfileId: null, providerSessionId: 'provider-session', workingDirectory: '/queue-test', recordedAt: 1 },
    };
    await spawnQueueInstance(config('worker'), spawnHost());
    expect(instances.createInstance).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'claude', sessionId: 'provider-session', resume: true }));

    saved = [{ teamId: COM.teamId, providers: ['codex'] }];
    vi.mocked(instances.createInstance).mockClear();
    await expect(spawnQueueInstance(config('worker'), spawnHost())).rejects.toThrow(refusal('claude', 'COM'));
    expect(instances.createInstance).not.toHaveBeenCalled();
  });

  it('marks a Linear run\'s session so a live move to another provider can be refused, and marks no other', async () => {
    await spawnQueueInstance(config('worker'), spawnHost());
    expect(instances.createInstance).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ planQueueRunKind: 'tickets' }) }));
    run = { ...run, kind: 'plans' };
    await spawnQueueInstance(config('worker'), spawnHost());
    expect(vi.mocked(instances.createInstance).mock.calls.at(-1)![0].metadata).not.toHaveProperty('planQueueRunKind');
  });

  it('a failure to read the run\'s teams stops the session with the reason instead of starting it', async () => {
    _setLinearProviderPolicyForTesting(new LinearProviderPolicy({ readTeams: () => saved, teamsOfRun: () => { throw new Error('table unavailable'); } }));
    await expect(spawnQueueInstance(config('worker'), spawnHost())).rejects.toThrow('table unavailable');
    expect(instances.createInstance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// After set-routing
// ---------------------------------------------------------------------------------------------------------------------

describe('after set-routing', () => {
  function fixture(kind: 'tickets' | 'plans' = 'tickets') {
    const run: PlanQueueRun = { ...ticketsRun(), kind, config: { ...ticketsRun().config, routing: { workers: [{ provider: 'claude' }], verifiers: [] } } };
    const host = {
      preflightRun: vi.fn(async () => undefined), getRun: () => run, hasParkedWork: () => true, parentRoute: () => ({ provider: 'claude' }),
      upsertRun: vi.fn(), holdRun: vi.fn().mockResolvedValue(undefined), requestPump: vi.fn(), notifyParent: vi.fn(),
    };
    const deps: PlanQueueRoutingDeps = {
      readSaved: () => ({ workers: [], verifiers: [] }), readAccountRules: () => ({ never: [], last: [] }), copilotProfileFor: () => null, poolProfiles: () => [], copilotProfiles: () => [],
      isProviderExcluded: () => false, defaultProvider: () => null, checkerScopeKind: () => 'none',
      listInstalledProviders: async () => planQueueProviderChoices().map((choice) => choice.id),
    };
    return { run, host, deps };
  }

  it.each(['panel', 'parent'] as const)('a change to a provider that is not on the list is refused and nothing is saved, from the %s', async (actor) => {
    const { run, host, deps } = fixture();
    const before = JSON.stringify(run.config.routing);
    await expect(changeRunRouting(host, run, { workers: [{ provider: 'cursor' }], verifiers: [] }, actor, false, deps)).rejects.toThrow(refusal('cursor', 'COM'));
    expect(host.upsertRun).not.toHaveBeenCalled();
    expect(host.notifyParent).not.toHaveBeenCalled();
    expect(host.holdRun).not.toHaveBeenCalled();
    expect(JSON.stringify(run.config.routing)).toBe(before);
  });

  it('refuses a checker choice and a step-up choice that are not on the list', async () => {
    const { run, host, deps } = fixture();
    await expect(changeRunRouting(host, run, { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'cursor' }] }, 'panel', false, deps)).rejects.toThrow(refusal('cursor', 'COM'));
    await expect(changeRunRouting(host, run, { workers: [{ provider: 'claude' }], verifiers: [], stepUp: { provider: 'copilot' } }, 'panel', false, deps)).rejects.toThrow(refusal('copilot', 'COM'));
    expect(host.upsertRun).not.toHaveBeenCalled();
  });

  it('refuses an empty worker list when the starting session is on a provider that is not on the list', async () => {
    const { run, host, deps } = fixture();
    host.parentRoute = () => ({ provider: 'cursor' });
    await expect(changeRunRouting(host, run, { workers: [], verifiers: [] }, 'panel', false, deps)).rejects.toThrow(refusal('cursor', 'COM'));
    expect(host.upsertRun).not.toHaveBeenCalled();
  });

  it('saves a change to listed providers', async () => {
    const { run, host, deps } = fixture();
    await changeRunRouting(host, run, { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }] }, 'panel', false, deps);
    expect(host.upsertRun).toHaveBeenCalledTimes(1);
  });

  it('with tickets from two teams, accepts only a provider both allow', async () => {
    const { run, host, deps } = fixture();
    saved = [{ teamId: COM.teamId, providers: ['claude', 'codex'] }, { teamId: ORC.teamId, providers: ['codex'] }];
    runTeams = [COM, ORC];
    await expect(changeRunRouting(host, run, { workers: [{ provider: 'claude' }], verifiers: [] }, 'panel', false, deps)).rejects.toThrow(refusal('claude', 'ORC'));
    await changeRunRouting(host, run, { workers: [{ provider: 'codex' }], verifiers: [] }, 'panel', false, deps);
    expect(host.upsertRun).toHaveBeenCalledTimes(1);
  });

  it('checks the list again just before saving, when it changes while the other checks wait', async () => {
    const { run, host, deps } = fixture();
    host.preflightRun = vi.fn(async () => { saved = [{ teamId: COM.teamId, providers: ['claude'] }]; });
    await expect(changeRunRouting(host, run, { workers: [{ provider: 'codex' }], verifiers: [] }, 'panel', false, deps)).rejects.toThrow(refusal('codex', 'COM'));
    expect(host.upsertRun).not.toHaveBeenCalled();
  });

  it('leaves a plans run alone', async () => {
    const { run, host, deps } = fixture('plans');
    saved = [];
    await changeRunRouting(host, run, { workers: [{ provider: 'cursor' }], verifiers: [] }, 'panel', false, deps);
    expect(host.upsertRun).toHaveBeenCalledTimes(1);
  });
});
