import { describe, expect, it } from 'vitest';
import { PlanQueueRoutingSchema, PlanQueueStartArgsSchema, type PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { CopilotAccountProfile } from '../../shared/types/copilot-account.types';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import {
  chooseQueueWorker,
  describeRouting,
  queueWorkerChoices,
  resolveRunRouting,
  routeChoiceFromArgs,
  routeQueueSpawn,
  type PlanQueueRoutingDeps,
} from './plan-queue-routing';
import type { PlanQueueRun } from './plan-queue.types';

function pool(id: string, provider: 'claude' | 'codex', overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider, label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null, priority: 0,
    enabled: true, automationPolicy: 'allow-routed', isLegacy: false, createdAt: 0, updatedAt: 0, ...overrides,
  };
}

function copilot(id: string, overrides: Partial<CopilotAccountProfile> = {}): CopilotAccountProfile {
  return {
    id, label: id, expectedLogin: null, host: 'github.com', accountKind: 'personal', scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed', isDefault: false, isLegacy: false, createdAt: 0, updatedAt: 0, ...overrides,
  } as CopilotAccountProfile;
}

function deps(overrides: {
  saved?: PlanQueueRouting;
  pool?: ProviderAccountProfile[];
  copilot?: CopilotAccountProfile[];
  excluded?: string[];
  defaultProvider?: string | null;
  scope?: string;
} = {}): PlanQueueRoutingDeps {
  return {
    readSaved: () => overrides.saved ?? { workers: [], verifiers: [] },
    readAccountRules: () => ({ never: [], last: [] }),
    copilotProfileFor: () => null,
    poolProfiles: () => overrides.pool ?? [],
    copilotProfiles: () => overrides.copilot ?? [],
    isProviderExcluded: (provider) => (overrides.excluded ?? []).includes(provider),
    defaultProvider: () => overrides.defaultProvider ?? null,
    checkerScopeKind: () => overrides.scope ?? 'none',
  };
}

/** The routing alone; the set-aside roles are checked where they matter. */
const resolveRouting = (...args: Parameters<typeof resolveRunRouting>) => resolveRunRouting(...args).routing;

describe('resolveRunRouting — inheriting the starting session', () => {
  it('takes the session\'s provider, model and automation-allowed account', () => {
    const routing = resolveRouting(
      { provider: 'codex', currentModel: 'gpt-6.1-sol', accountProfileId: 'pro-2' },
      undefined,
      deps({ pool: [pool('pro-1', 'codex'), pool('pro-2', 'codex')] }),
    );
    expect(routing).toEqual({ workers: [{ provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-2'] }], verifiers: [] });
  });

  it.each([
    ['manual only', { automationPolicy: 'manual-only' as const }],
    ['never', { automationPolicy: 'disabled' as const }],
    ['turned off', { enabled: false }],
  ])('does not inherit an account set to %s', (_label, overrides) => {
    const routing = resolveRouting({ provider: 'claude', accountProfileId: 'max' }, undefined, deps({ pool: [pool('max', 'claude', overrides)] }));
    expect(routing.workers).toEqual([{ provider: 'claude' }]);
  });

  it('inherits an automation-allowed Copilot account, never a manual-only one', () => {
    expect(resolveRouting({ provider: 'copilot', copilotAccountProfileId: 'personal' }, undefined, deps({ copilot: [copilot('personal')] })).workers)
      .toEqual([{ provider: 'copilot', copilotProfileId: 'personal' }]);
    expect(resolveRouting(
      { provider: 'copilot', copilotAccountProfileId: 'work' },
      undefined,
      deps({ copilot: [copilot('work', { automationPolicy: 'manual-only' })] }),
    ).workers).toEqual([{ provider: 'copilot' }]);
  });

  it('resolves an "auto" session to the default provider, and leaves a fully automatic one to the spawn', () => {
    expect(resolveRouting({ provider: 'auto', currentModel: 'x' }, undefined, deps({ defaultProvider: 'codex' })).workers)
      .toEqual([{ provider: 'codex' }]);
    expect(resolveRouting({ provider: 'auto' }, undefined, deps()).workers).toEqual([]);
  });

  it('refuses a run whose inherited provider is on the never-auto-pick list', () => {
    expect(() => resolveRouting({ provider: 'copilot' }, undefined, deps({ excluded: ['copilot'] })))
      .toThrow('Plan Queue worker: copilot is on the "never auto-pick these providers" list, so queue sessions cannot use it');
    expect(() => resolveRouting({ provider: 'auto' }, undefined, deps({ excluded: ['copilot'], defaultProvider: 'copilot' })))
      .toThrow('never auto-pick');
  });

  it('drops an inherited OpenCode account for a model the account pool does not serve', () => {
    const mimo = pool('mimo', 'claude', { provider: 'opencode' as never, region: 'ams' } as never);
    expect(resolveRouting({ provider: 'opencode', currentModel: 'opencode/big-pickle', accountProfileId: 'mimo' }, undefined, deps({ pool: [mimo] })).workers)
      .toEqual([{ provider: 'opencode', model: 'opencode/big-pickle' }]);
    expect(resolveRouting({ provider: 'opencode', currentModel: 'xiaomi-token-plan/mimo-v2.6-pro', accountProfileId: 'mimo' }, undefined, deps({ pool: [mimo] })).workers)
      .toEqual([{ provider: 'opencode', model: 'xiaomi-token-plan/mimo-v2.6-pro', accountProfileIds: ['mimo'] }]);
  });
});

describe('resolveRunRouting — saved and per-run choices', () => {
  it('keeps James\'s saved list for each role, using a per-run choice only where he saved none', () => {
    const saved: PlanQueueRouting = { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }] };
    expect(resolveRunRouting({ provider: 'claude' }, undefined, deps({ saved })))
      .toEqual({ routing: { ...saved, checkersChosenBy: 'saved' }, setAside: [], accountNotes: [] });
    expect(resolveRunRouting({ provider: 'claude' }, { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'cursor' }] }, deps({ saved })))
      .toEqual({ routing: { ...saved, checkersChosenBy: 'saved' }, setAside: ['workers', 'checkers'], accountNotes: [] });
    // An explicit "automatic" from chat is a per-run choice too.
    expect(resolveRunRouting({ provider: 'claude' }, { verifiers: [] }, deps({ saved })).setAside).toEqual(['checkers']);

    const workersOnly: PlanQueueRouting = { workers: [{ provider: 'codex' }], verifiers: [] };
    expect(resolveRunRouting({ provider: 'claude' }, { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'claude' }] }, deps({ saved: workersOnly })))
      .toEqual({ routing: { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'run' }, setAside: ['workers'], accountNotes: [] });
    const checkersOnly: PlanQueueRouting = { workers: [], verifiers: [{ provider: 'claude' }] };
    expect(resolveRouting({ provider: 'claude' }, { workers: [{ provider: 'cursor' }] }, deps({ saved: checkersOnly })))
      .toEqual({ workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'saved' });
  });

  it('keeps a ranked worker list in order, checking every choice and naming the one it refuses', () => {
    const pools = deps({ pool: [pool('max-a', 'claude'), pool('manual', 'claude', { automationPolicy: 'manual-only' })] });
    expect(resolveRouting({}, { workers: [{ provider: 'claude', accountProfileIds: ['max-a'] }, { provider: ' Codex ', model: 'gpt-6.1-sol' }] }, pools).workers)
      .toEqual([{ provider: 'claude', accountProfileIds: ['max-a'] }, { provider: 'codex', model: 'gpt-6.1-sol' }]);
    expect(() => resolveRouting({}, { workers: [{ provider: 'codex' }, { provider: 'claude', accountProfileIds: ['manual'] }] }, pools))
      .toThrow('Plan Queue worker choice 2: the claude account "manual" is set to "manual only" for automatic work');
    expect(() => resolveRouting({}, { workers: [{ provider: 'codex' }, { provider: 'copilot' }] }, deps({ excluded: ['copilot'] })))
      .toThrow('Plan Queue worker choice 2: copilot is on the "never auto-pick these providers" list');
  });

  it('normalises provider ids', () => {
    const routing = resolveRouting({}, { workers: [{ provider: ' Codex ' }], verifiers: [{ provider: 'CLAUDE' }] }, deps());
    expect(routing).toEqual({ workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'run' });
  });

  it('skips the never-auto-pick check for a run that relaxes that list', () => {
    const d = deps({ excluded: ['copilot'] });
    expect(resolveRouting({ provider: 'copilot' }, { verifiers: [{ provider: 'claude' }], relaxExclusions: true }, d))
      .toEqual({ workers: [{ provider: 'copilot' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'run' });
    expect(resolveRouting({ provider: 'claude' }, { verifiers: [{ provider: 'copilot' }], relaxExclusions: true }, d).verifiers)
      .toEqual([{ provider: 'copilot' }]);
  });

  it('checks a legacy alias under both the id chosen and the CLI that actually runs', () => {
    expect(() => resolveRouting({}, { verifiers: [{ provider: 'gemini' }] }, deps({ excluded: ['antigravity'] })))
      .toThrow('Plan Queue checker: antigravity is on the "never auto-pick these providers" list');
    expect(() => resolveRouting({}, { workers: [{ provider: 'gemini' }] }, deps({ excluded: ['gemini'] })))
      .toThrow('Plan Queue worker: gemini is on the "never auto-pick these providers" list');
    expect(() => resolveRouting({ provider: 'gemini' }, undefined, deps({ excluded: ['gemini'] })))
      .toThrow('Plan Queue worker: gemini is on the "never auto-pick these providers" list');
    expect(resolveRouting({}, { workers: [{ provider: 'openai' }] }, deps()).workers).toEqual([{ provider: 'codex' }]);
    expect(resolveRouting({ provider: 'auto' }, undefined, deps({ defaultProvider: 'gemini' })).workers).toEqual([{ provider: 'antigravity' }]);
  });

  it('refuses a worker or checker on the never-auto-pick list', () => {
    const d = deps({ excluded: ['copilot'] });
    expect(() => resolveRouting({}, { workers: [{ provider: 'copilot' }] }, d))
      .toThrow('Plan Queue worker: copilot is on the "never auto-pick these providers" list');
    expect(() => resolveRouting({}, { verifiers: [{ provider: 'copilot' }] }, d))
      .toThrow('Plan Queue checker: copilot is on the "never auto-pick these providers" list');
  });

  it.each([
    [{ workers: [{ provider: 'nope' }] }, 'Plan Queue worker: "nope" is not a provider the queue can use here'],
    [{ verifiers: [{ provider: 'ollama' }] }, 'Plan Queue checker: "ollama" is not a provider the queue can use here'],
    [{ workers: [{ provider: 'cursor', accountProfileIds: ['x'] }] }, 'cursor has no account pool'],
    [{ workers: [{ provider: 'claude', accountProfileIds: ['missing'] }] }, 'there is no claude account "missing"'],
    [{ workers: [{ provider: 'claude', accountProfileIds: ['pro-1'] }] }, 'there is no claude account "pro-1"'],
    [{ workers: [{ provider: 'claude', accountProfileIds: ['manual'] }] }, 'the claude account "manual" is set to "manual only" for automatic work'],
    [{ verifiers: [{ provider: 'codex', copilotProfileId: 'personal' }] }, 'a Copilot account was chosen for codex'],
    [{ verifiers: [{ provider: 'copilot', copilotProfileId: 'work' }] }, 'the Copilot account "work" is set to "manual only"'],
    [{ verifiers: [{ provider: 'copilot', copilotProfileId: 'gone' }] }, 'there is no Copilot account "gone"'],
    [{ workers: [{ provider: 'opencode', accountProfileIds: ['mimo'] }] }, 'OpenCode accounts only apply to MiMo Token Plan models'],
  ])('refuses %j', (override, message) => {
    const d = deps({
      pool: [pool('pro-1', 'codex'), pool('manual', 'claude', { automationPolicy: 'manual-only' })],
      copilot: [copilot('personal'), copilot('work', { automationPolicy: 'manual-only' })],
    });
    expect(() => resolveRouting({ provider: 'claude' }, override, d)).toThrow(message);
  });
});

describe('resolveRunRouting — checkers that could never check the work', () => {
  it('refuses checkers that all share the workers\' provider without a different-maker model', () => {
    expect(() => resolveRouting({ provider: 'claude' }, { verifiers: [{ provider: 'claude' }] }, deps()))
      .toThrow('None of the chosen checkers can check this run: they all use claude');
    expect(() => resolveRouting({}, { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'openai' }] }, deps()))
      .toThrow('they all use codex');
  });

  it('accepts a same-provider checker with a model from another maker, or any checker on another provider', () => {
    expect(resolveRouting({}, { workers: [{ provider: 'copilot', model: 'gpt-5.5' }], verifiers: [{ provider: 'copilot', model: 'claude-opus-5' }] }, deps()).verifiers)
      .toHaveLength(1);
    expect(resolveRouting({ provider: 'claude' }, { verifiers: [{ provider: 'claude' }, { provider: 'codex' }] }, deps()).verifiers)
      .toHaveLength(2);
    // Worker model unknown at start on a multi-maker provider: the live model decides at verification time.
    expect(resolveRouting({}, { workers: [{ provider: 'copilot' }], verifiers: [{ provider: 'copilot', model: 'claude-opus-5' }] }, deps()).verifiers)
      .toHaveLength(1);
  });

  it('refuses a same-provider checker on a single-maker provider when the workers\' model is not named', () => {
    expect(() => resolveRouting({}, { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'codex', model: 'gpt-5.5' }] }, deps()))
      .toThrow('they all use codex');
    expect(() => resolveRouting({}, { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'claude', model: 'claude-sonnet-5' }] }, deps()))
      .toThrow('they all use claude');
  });

  it('refuses a same-provider OpenCode checker until the workers\' OpenCode model is named', () => {
    expect(() => resolveRouting({}, { workers: [{ provider: 'opencode' }], verifiers: [{ provider: 'opencode', model: 'anthropic/claude-opus-5' }] }, deps()))
      .toThrow('on OpenCode, also name the workers\' model');
    expect(resolveRouting({}, { workers: [{ provider: 'opencode', model: 'openai/gpt-5.5' }], verifiers: [{ provider: 'opencode', model: 'anthropic/claude-opus-5' }] }, deps()).verifiers)
      .toHaveLength(1);
  });

  it('accepts a different-maker checker on Antigravity, which serves Gemini, Claude and GPT models', () => {
    expect(resolveRouting({}, { workers: [{ provider: 'antigravity' }], verifiers: [{ provider: 'gemini', model: 'Claude Opus 4.6 (Thinking)' }] }, deps()).verifiers)
      .toEqual([{ provider: 'antigravity', model: 'Claude Opus 4.6 (Thinking)' }]);
  });

  it('needs a checker that can judge every worker choice', () => {
    expect(() => resolveRouting({}, { workers: [{ provider: 'codex' }, { provider: 'claude' }], verifiers: [{ provider: 'claude' }] }, deps()))
      .toThrow('None of the chosen checkers can check every worker choice: they all use claude, worker choice 2\'s provider');
    expect(resolveRouting({}, { workers: [{ provider: 'codex' }, { provider: 'claude' }], verifiers: [{ provider: 'claude' }, { provider: 'codex' }] }, deps()).verifiers)
      .toHaveLength(2);
  });

  it('refuses a same-family model on the workers\' provider', () => {
    expect(() => resolveRouting({}, { workers: [{ provider: 'copilot', model: 'gpt-5.5' }], verifiers: [{ provider: 'copilot', model: 'gpt-5.4' }] }, deps()))
      .toThrow('None of the chosen checkers can check this run');
  });
});

describe('resolveRunRouting — the work Copilot seat', () => {
  it('refuses a per-run checker list where a work Copilot rule applies, but not the saved list', () => {
    const saved: PlanQueueRouting = { workers: [], verifiers: [{ provider: 'claude' }] };
    expect(() => resolveRouting({ provider: 'codex' }, { verifiers: [{ provider: 'claude' }], workspaceCwd: '/repo' }, deps({ scope: 'protected' })))
      .toThrow('checkers given for one run cannot replace the work seat here');
    expect(() => resolveRouting({ provider: 'codex' }, { verifiers: [{ provider: 'claude' }], workspaceCwd: '/repo' }, deps({ scope: 'indeterminate' })))
      .toThrow('cannot replace the work seat');
    expect(resolveRouting({ provider: 'codex' }, { workspaceCwd: '/repo' }, deps({ saved, scope: 'protected' })).checkersChosenBy).toBe('saved');
    // James's saved list wins over any per-run list, so nothing per-run reaches the work seat.
    expect(resolveRouting({ provider: 'codex' }, { verifiers: [], workspaceCwd: '/repo' }, deps({ saved, scope: 'protected' })))
      .toMatchObject({ verifiers: [{ provider: 'claude' }], checkersChosenBy: 'saved' });
    expect(resolveRouting({ provider: 'codex' }, { verifiers: [{ provider: 'cursor' }], workspaceCwd: '/repo' }, deps({ saved, scope: 'protected' })))
      .toMatchObject({ verifiers: [{ provider: 'claude' }], checkersChosenBy: 'saved' });
    expect(resolveRouting({ provider: 'codex' }, { verifiers: [{ provider: 'claude' }], workspaceCwd: '/repo' }, deps()).checkersChosenBy).toBe('run');
  });

  it('says where an inherited provider came from when refusing it', () => {
    expect(() => resolveRouting({ provider: 'copilot' }, undefined, deps({ excluded: ['copilot'] })))
      .toThrow('The run took this provider from the session that started it');
    expect(() => resolveRouting({ provider: 'auto' }, undefined, deps({ excluded: ['copilot'], defaultProvider: 'copilot' })))
      .toThrow('The run took this provider from the default provider setting');
  });
});

describe('routeQueueSpawn', () => {
  const run = (routing?: PlanQueueRouting) => ({ config: { routing } }) as unknown as PlanQueueRun;
  const spawn = (role: string, extra: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig =>
    ({ metadata: { planQueueRunId: 'run-1', planQueueRole: role }, ...extra }) as InstanceCreateConfig;

  it('keeps every queue session on its provider: no cross-provider failover', () => {
    expect(routeQueueSpawn(spawn('verifier', { provider: 'claude' }), () => run(), null, () => false, { never: [], last: [] }).failoverProviders).toEqual([]);
    expect(routeQueueSpawn(spawn('worker', { provider: 'claude' }), () => run(), null, () => false, { never: [], last: [] }).failoverProviders).toEqual([]);
  });

  it('refuses a new worker on a provider added to the never-auto-pick list mid-run, unless the run relaxes it', () => {
    const excluded = (provider: string) => provider === 'antigravity';
    expect(() => routeQueueSpawn(spawn('worker', { provider: 'gemini' }), () => run(), null, excluded, { never: [], last: [] }))
      .toThrow('antigravity has been added to the "never auto-pick these providers" list since this run started');
    const relaxed = { config: { relaxSettings: true } } as unknown as PlanQueueRun;
    expect(routeQueueSpawn(spawn('worker', { provider: 'gemini' }), () => relaxed, null, excluded, { never: [], last: [] }).accountRouteOrigin).toBe('automation');
    // The verifier is re-checked at selection, not here.
    expect(routeQueueSpawn(spawn('verifier', { provider: 'antigravity' }), () => run(), null, excluded, { never: [], last: [] }).accountRouteOrigin).toBe('verification');
    // A chosen worker on that list is refused the same way.
    expect(() => routeQueueSpawn(spawn('worker'), () => run({ workers: [{ provider: 'antigravity' }], verifiers: [] }), { provider: 'antigravity' }, excluded, { never: [], last: [] }))
      .toThrow('antigravity has been added');
  });

  it('passes a non-queue spawn through untouched', () => {
    const config = { displayName: 'x' } as InstanceCreateConfig;
    expect(routeQueueSpawn(config, () => run(), null, () => false, { never: [], last: [] })).toBe(config);
  });

  it('routes a verifier as verification work and keeps its own accounts', () => {
    const worker = { provider: 'codex', accountProfileIds: ['pro-1'] };
    expect(routeQueueSpawn(spawn('verifier', { provider: 'claude', allowedAccountProfileIds: ['max-b'] }), () => run({
      workers: [worker], verifiers: [],
    }), worker, () => false, { never: [], last: [] })).toMatchObject({ accountRouteOrigin: 'verification', allowedAccountProfileIds: ['max-b'] });
  });

  it.each(['worker', 'triage'])('fences a %s to the chosen worker accounts as automatic work', (role) => {
    const chosen = { provider: 'codex', accountProfileIds: ['pro-1', 'pro-2'] };
    expect(routeQueueSpawn(spawn(role, { provider: 'claude' }), () => run({
      workers: [{ provider: 'claude' }, chosen], verifiers: [],
    }), chosen, () => false, { never: [], last: [] })).toMatchObject({ provider: 'codex', accountRouteOrigin: 'automation', allowedAccountProfileIds: ['pro-1', 'pro-2'] });
  });

  it('routes a Copilot worker as automatic work too, pinning its chosen account', () => {
    const worker = { provider: 'copilot', copilotProfileId: 'personal' };
    const routed = routeQueueSpawn(spawn('worker', { provider: 'copilot' }), () => run({ workers: [worker], verifiers: [] }), worker, () => false, { never: [], last: [] });
    expect(routed).toMatchObject({ accountRouteOrigin: 'automation', copilotAccountProfileId: 'personal' });
  });

  it('still routes an older run without recorded routing as automatic work', () => {
    expect(routeQueueSpawn(spawn('worker', { provider: 'claude' }), () => run(), null, () => false, { never: [], last: [] })).toMatchObject({ accountRouteOrigin: 'automation' });
    expect(routeQueueSpawn(spawn('worker'), () => null, null, () => false, { never: [], last: [] }).allowedAccountProfileIds).toBeUndefined();
  });

  it('fills the worker provider, model and account fence from the chosen route, never a stale caller snapshot', () => {
    let reads = 0;
    const chosen = { provider: 'claude', model: 'new-model', accountProfileIds: ['new-account'] };
    const current = run({ workers: [chosen], verifiers: [] });
    const result = routeQueueSpawn(spawn('worker', { provider: 'codex', modelOverride: 'old-model', allowedAccountProfileIds: ['old-account'], copilotAccountProfileId: 'old-seat' }), () => { reads += 1; return current; }, chosen, () => false, { never: [], last: [] });
    expect(reads).toBe(1);
    expect(result).toMatchObject({ provider: 'claude', modelOverride: 'new-model', allowedAccountProfileIds: ['new-account'] });
    expect(result.copilotAccountProfileId).toBeUndefined();
  });

  it('clears a stale explicit provider and model when the run now routes automatically', () => {
    const current = run({ workers: [], verifiers: [] });
    current.workerProvider = null;
    const result = routeQueueSpawn(spawn('worker', { provider: 'codex', modelOverride: 'old' }), () => current, null, () => false, { never: [], last: [] });
    expect(result.provider).toBeUndefined();
    expect(result.modelOverride).toBeUndefined();
  });

  it('keeps a triage retry on the selected checker accounts rather than worker accounts', () => {
    const config = spawn('triage', { provider: 'claude', allowedAccountProfileIds: ['checker-account'] });
    config.metadata = { ...config.metadata, planQueueTriageRetry: true };
    expect(routeQueueSpawn(config, () => run({ workers: [{ provider: 'codex', accountProfileIds: ['worker-account'] }], verifiers: [] }), null, () => false, { never: [], last: [] }))
      .toMatchObject({ provider: 'claude', allowedAccountProfileIds: ['checker-account'] });
  });
});

describe('ranked worker choices', () => {
  const ranked = [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'cursor' }];
  const run = (relaxSettings = false) => ({ id: 'run-1', config: { relaxSettings, routing: { workers: ranked, verifiers: [] } } }) as unknown as PlanQueueRun;
  const spawn = (role: string, metadata: Record<string, unknown> = {}): InstanceCreateConfig =>
    ({ metadata: { planQueueRunId: 'run-1', planQueueRole: role, ...metadata } }) as unknown as InstanceCreateConfig;
  const never = () => false;

  it('offers the run\'s list to workers and first triage only', () => {
    expect(queueWorkerChoices(spawn('worker'), run(), never)).toEqual(ranked);
    expect(queueWorkerChoices(spawn('triage'), run(), never)).toEqual(ranked);
    expect(queueWorkerChoices(spawn('triage', { planQueueTriageRetry: true }), run(), never)).toEqual([]);
    expect(queueWorkerChoices(spawn('verifier'), run(), never)).toEqual([]);
    expect(queueWorkerChoices(spawn('worker'), null, never)).toEqual([]);
  });

  it('leaves out choices since added to the never-auto-pick list, keeping the first when all are listed', () => {
    expect(queueWorkerChoices(spawn('worker'), run(), (provider) => provider === 'codex')).toEqual([{ provider: 'claude' }, { provider: 'cursor' }]);
    expect(queueWorkerChoices(spawn('worker'), run(), () => true)).toEqual([{ provider: 'claude' }]);
    expect(queueWorkerChoices(spawn('worker'), run(true), () => true)).toEqual(ranked);
  });

  it('takes the first choice with usage left, else the one whose limit lifts soonest, else the first', async () => {
    const usage = (table: Record<string, { usable: boolean; resumeAt: number | null }>) =>
      async (choice: { provider: string }) => table[choice.provider]!;
    expect(await chooseQueueWorker(ranked, usage({ claude: { usable: false, resumeAt: 50 }, codex: { usable: true, resumeAt: null }, cursor: { usable: true, resumeAt: null } }), 'run-1'))
      .toEqual({ provider: 'codex' });
    expect(await chooseQueueWorker(ranked, usage({ claude: { usable: false, resumeAt: 90 }, codex: { usable: false, resumeAt: null }, cursor: { usable: false, resumeAt: 40 } }), 'run-1'))
      .toEqual({ provider: 'cursor' });
    expect(await chooseQueueWorker(ranked, usage({ claude: { usable: false, resumeAt: null }, codex: { usable: false, resumeAt: null }, cursor: { usable: false, resumeAt: null } }), 'run-1'))
      .toEqual({ provider: 'claude' });
  });

  it('never checks usage for a single choice or none', async () => {
    let checks = 0;
    const usage = async () => { checks += 1; return { usable: false, resumeAt: null }; };
    expect(await chooseQueueWorker([{ provider: 'claude' }], usage, 'run-1')).toEqual({ provider: 'claude' });
    expect(await chooseQueueWorker([], usage, 'run-1')).toBeNull();
    expect(checks).toBe(0);
  });
});

describe('step-up choice', () => {
  const haiku = { provider: 'claude', model: 'haiku' };
  const opus = { provider: 'claude', model: 'opus' };
  const withRules = (base: PlanQueueRoutingDeps, never: { provider: 'claude' | 'codex' | 'opencode' | 'copilot'; accountId: string }[]): PlanQueueRoutingDeps =>
    ({ ...base, readAccountRules: () => ({ never, last: [] }) });

  it('takes James\'s saved step-up first, else the per-run one, and reports a per-run one set aside', () => {
    expect(resolveRunRouting({}, { workers: [haiku], stepUp: { provider: 'codex' } }, deps({ saved: { workers: [], verifiers: [], stepUp: opus } })))
      .toEqual({ routing: { workers: [haiku], verifiers: [], stepUp: opus }, setAside: ['step-up'], accountNotes: [] });
    expect(resolveRunRouting({}, { workers: [haiku], stepUp: { provider: ' Codex ' } }, deps()))
      .toEqual({ routing: { workers: [haiku], verifiers: [], stepUp: { provider: 'codex' } }, setAside: [], accountNotes: [] });
    // Neither: no step-up, so the run parks a stuck document as before.
    expect(resolveRouting({}, { workers: [haiku] }, deps())).toEqual({ workers: [haiku], verifiers: [] });
    expect(resolveRunRouting({}, { workers: [haiku] }, deps({ saved: { workers: [], verifiers: [], stepUp: opus } })).setAside).toEqual([]);
  });

  it('refuses a step-up the queue could not honour, naming it as the step-up worker', () => {
    expect(() => resolveRouting({}, { workers: [haiku], stepUp: { provider: 'nope' } }, deps()))
      .toThrow('Plan Queue step-up worker: "nope" is not a provider the queue can use here');
    expect(() => resolveRouting({}, { workers: [haiku], stepUp: { provider: 'codex' } }, deps({ excluded: ['codex'] })))
      .toThrow('Plan Queue step-up worker: codex is on the "never auto-pick these providers" list');
    // A run that relaxes the auto-pick list may use it.
    expect(resolveRouting({}, { workers: [haiku], stepUp: { provider: 'codex' }, relaxExclusions: true }, deps({ excluded: ['codex'] })).stepUp)
      .toEqual({ provider: 'codex' });
    const pools = deps({ pool: [pool('max-a', 'claude'), pool('max-b', 'claude')] });
    expect(() => resolveRouting({}, { workers: [haiku], stepUp: { ...opus, accountProfileIds: ['max-a'] } }, withRules(pools, [{ provider: 'claude', accountId: 'max-a' }])))
      .toThrow(/^Plan Queue step-up worker: .*never-use list/);
  });

  it('refuses explicit checkers that could not judge the step-up worker', () => {
    // Codex workers with a Claude checker are fine; a Claude step-up leaves nothing to check it.
    expect(() => resolveRouting({}, { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }], stepUp: opus }, deps()))
      .toThrow('None of the chosen checkers can check the step-up worker: they all use claude, its provider, without a model from a different maker.');
    expect(resolveRouting({}, { workers: [haiku], verifiers: [{ provider: 'codex' }], stepUp: opus }, deps()).stepUp).toEqual(opus);
    // Automatic checkers are chosen per check, so nothing is refused up front.
    expect(resolveRouting({}, { workers: [{ provider: 'codex' }], stepUp: opus }, deps()).stepUp).toEqual(opus);
  });

  it('refuses a Copilot step-up whose folder seat is on the never-use list', () => {
    const base = { ...deps({ copilot: [copilot('work')] }), copilotProfileFor: () => 'work' };
    expect(() => resolveRouting({}, { workers: [haiku], stepUp: { provider: 'copilot' }, workspaceCwd: '/repo' }, withRules(base, [{ provider: 'copilot', accountId: 'work' }])))
      .toThrow('The Plan Queue step-up worker: this folder\'s Copilot account ("work") is on your never-use list.');
    expect(resolveRouting({}, { workers: [haiku], stepUp: { provider: 'copilot', copilotProfileId: 'work' }, workspaceCwd: '/repo' }, base).stepUp)
      .toEqual({ provider: 'copilot', copilotProfileId: 'work' });
  });

  it('routes only a handed-over document\'s workers to the step-up choice', () => {
    const run = (stepUp?: typeof opus) => ({ id: 'run-1', config: { relaxSettings: false, routing: { workers: [haiku, { provider: 'codex' }], verifiers: [], ...(stepUp ? { stepUp } : {}) } } }) as unknown as PlanQueueRun;
    const spawn = (role: string, metadata: Record<string, unknown> = {}): InstanceCreateConfig =>
      ({ metadata: { planQueueRunId: 'run-1', planQueueRole: role, ...metadata } }) as unknown as InstanceCreateConfig;
    const never = () => false;
    expect(queueWorkerChoices(spawn('worker', { planQueueSteppedUp: true }), run(opus), never)).toEqual([opus]);
    expect(queueWorkerChoices(spawn('worker'), run(opus), never)).toEqual([haiku, { provider: 'codex' }]);
    // The step-up choice was removed after the handover: back to the ordinary workers.
    expect(queueWorkerChoices(spawn('worker', { planQueueSteppedUp: true }), run(), never)).toEqual([haiku, { provider: 'codex' }]);
    expect(queueWorkerChoices(spawn('triage', { planQueueSteppedUp: true }), run(opus), never)).toEqual([haiku, { provider: 'codex' }]);
    // Added to the never-auto-pick list since: kept, so the spawn refuses with the reason.
    expect(queueWorkerChoices(spawn('worker', { planQueueSteppedUp: true }), run(opus), () => true)).toEqual([opus]);
    const routed = routeQueueSpawn(spawn('worker', { planQueueSteppedUp: true }), () => run(opus), opus, never, { never: [], last: [] });
    expect(routed).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
  });
});

describe('helpers', () => {
  it('maps tool arguments, dropping duplicate and empty account lists', () => {
    expect(routeChoiceFromArgs({ provider: 'claude', account_ids: ['a', 'a', 'b'], copilot_account_id: 'p' }))
      .toEqual({ provider: 'claude', accountProfileIds: ['a', 'b'], copilotProfileId: 'p' });
    expect(routeChoiceFromArgs({ provider: 'codex', account_ids: [] })).toEqual({ provider: 'codex' });
  });

  it('describes routing in one line per role, workers in order', () => {
    expect(describeRouting({ workers: [{ provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-1'] }, { provider: 'claude' }], verifiers: [] }))
      .toEqual({ workers: 'codex / gpt-6.1-sol (accounts: pro-1), then claude', checkers: 'automatic', stepUp: 'stop and wait' });
    expect(describeRouting({ workers: [], verifiers: [{ provider: 'claude' }, { provider: 'copilot', copilotProfileId: 'p' }] }))
      .toEqual({ workers: 'the default provider', checkers: 'claude; copilot (account: p)', stepUp: 'stop and wait' });
    expect(describeRouting({ workers: [{ provider: 'claude', model: 'haiku' }], verifiers: [], stepUp: { provider: 'claude', model: 'opus', accountProfileIds: ['max-a'] } }).stepUp)
      .toBe('claude / opus (accounts: max-a)');
  });
});

describe('route choice schemas', () => {
  it('refuse a misspelt account key instead of silently dropping the fence', () => {
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', workers: [{ provider: 'claude', accounts: ['max-a'] }] }).success).toBe(false);
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', workers: [{ provider: 'claude', account_ids: ['max-a'] }] }).success).toBe(true);
    expect(PlanQueueRoutingSchema.safeParse({ workers: [{ provider: 'claude', accountIds: ['x'] }], verifiers: [] }).success).toBe(false);
  });

  it('refuses the old single-worker shape at the boundary', () => {
    expect(PlanQueueRoutingSchema.safeParse({ worker: { provider: 'claude' }, verifiers: [] }).success).toBe(false);
    // A chat session with a stale tool schema is told, not silently given James's or its session's provider.
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', worker: { provider: 'claude' } }).success).toBe(false);
  });
});
