import { describe, expect, it } from 'vitest';
import { PlanQueueRoutingSchema, PlanQueueStartArgsSchema, type PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { CopilotAccountProfile } from '../../shared/types/copilot-account.types';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import {
  describeRouting,
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
    readSaved: () => overrides.saved ?? { worker: null, verifiers: [] },
    poolProfiles: () => overrides.pool ?? [],
    copilotProfiles: () => overrides.copilot ?? [],
    isProviderExcluded: (provider) => (overrides.excluded ?? []).includes(provider),
    defaultProvider: () => overrides.defaultProvider ?? null,
    checkerScopeKind: () => overrides.scope ?? 'none',
  };
}

describe('resolveRunRouting — inheriting the starting session', () => {
  it('takes the session\'s provider, model and automation-allowed account', () => {
    const routing = resolveRunRouting(
      { provider: 'codex', currentModel: 'gpt-6.1-sol', accountProfileId: 'pro-2' },
      undefined,
      deps({ pool: [pool('pro-1', 'codex'), pool('pro-2', 'codex')] }),
    );
    expect(routing).toEqual({ worker: { provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-2'] }, verifiers: [] });
  });

  it.each([
    ['manual only', { automationPolicy: 'manual-only' as const }],
    ['never', { automationPolicy: 'disabled' as const }],
    ['turned off', { enabled: false }],
  ])('does not inherit an account set to %s', (_label, overrides) => {
    const routing = resolveRunRouting({ provider: 'claude', accountProfileId: 'max' }, undefined, deps({ pool: [pool('max', 'claude', overrides)] }));
    expect(routing.worker).toEqual({ provider: 'claude' });
  });

  it('inherits an automation-allowed Copilot account, never a manual-only one', () => {
    expect(resolveRunRouting({ provider: 'copilot', copilotAccountProfileId: 'personal' }, undefined, deps({ copilot: [copilot('personal')] })).worker)
      .toEqual({ provider: 'copilot', copilotProfileId: 'personal' });
    expect(resolveRunRouting(
      { provider: 'copilot', copilotAccountProfileId: 'work' },
      undefined,
      deps({ copilot: [copilot('work', { automationPolicy: 'manual-only' })] }),
    ).worker).toEqual({ provider: 'copilot' });
  });

  it('resolves an "auto" session to the default provider, and leaves a fully automatic one to the spawn', () => {
    expect(resolveRunRouting({ provider: 'auto', currentModel: 'x' }, undefined, deps({ defaultProvider: 'codex' })).worker)
      .toEqual({ provider: 'codex' });
    expect(resolveRunRouting({ provider: 'auto' }, undefined, deps()).worker).toBeNull();
  });

  it('refuses a run whose inherited provider is on the never-auto-pick list', () => {
    expect(() => resolveRunRouting({ provider: 'copilot' }, undefined, deps({ excluded: ['copilot'] })))
      .toThrow('Plan Queue worker: copilot is on the "never auto-pick these providers" list, so queue sessions cannot use it');
    expect(() => resolveRunRouting({ provider: 'auto' }, undefined, deps({ excluded: ['copilot'], defaultProvider: 'copilot' })))
      .toThrow('never auto-pick');
  });

  it('drops an inherited OpenCode account for a model the account pool does not serve', () => {
    const mimo = pool('mimo', 'claude', { provider: 'opencode' as never, region: 'ams' } as never);
    expect(resolveRunRouting({ provider: 'opencode', currentModel: 'opencode/big-pickle', accountProfileId: 'mimo' }, undefined, deps({ pool: [mimo] })).worker)
      .toEqual({ provider: 'opencode', model: 'opencode/big-pickle' });
    expect(resolveRunRouting({ provider: 'opencode', currentModel: 'xiaomi-token-plan/mimo-v2.6-pro', accountProfileId: 'mimo' }, undefined, deps({ pool: [mimo] })).worker)
      .toEqual({ provider: 'opencode', model: 'xiaomi-token-plan/mimo-v2.6-pro', accountProfileIds: ['mimo'] });
  });
});

describe('resolveRunRouting — saved and per-run choices', () => {
  it('prefers the saved choice over the session, and a per-run override over both', () => {
    const saved: PlanQueueRouting = { worker: { provider: 'codex' }, verifiers: [{ provider: 'claude' }] };
    expect(resolveRunRouting({ provider: 'claude' }, undefined, deps({ saved }))).toEqual({ ...saved, checkersChosenBy: 'saved' });
    expect(resolveRunRouting({ provider: 'claude' }, { worker: { provider: 'cursor' } }, deps({ saved })))
      .toEqual({ worker: { provider: 'cursor' }, verifiers: [{ provider: 'claude' }], checkersChosenBy: 'saved' });
    expect(resolveRunRouting({ provider: 'claude' }, { verifiers: [{ provider: 'cursor' }] }, deps({ saved })))
      .toEqual({ worker: { provider: 'codex' }, verifiers: [{ provider: 'cursor' }], checkersChosenBy: 'run' });
    expect(resolveRunRouting({ provider: 'claude' }, { verifiers: [] }, deps({ saved }))).toEqual({ worker: { provider: 'codex' }, verifiers: [] });
  });

  it('normalises provider ids', () => {
    const routing = resolveRunRouting({}, { worker: { provider: ' Codex ' }, verifiers: [{ provider: 'CLAUDE' }] }, deps());
    expect(routing).toEqual({ worker: { provider: 'codex' }, verifiers: [{ provider: 'claude' }], checkersChosenBy: 'run' });
  });

  it('skips the never-auto-pick check for a run that relaxes that list', () => {
    const d = deps({ excluded: ['copilot'] });
    expect(resolveRunRouting({ provider: 'copilot' }, { verifiers: [{ provider: 'claude' }], relaxExclusions: true }, d))
      .toEqual({ worker: { provider: 'copilot' }, verifiers: [{ provider: 'claude' }], checkersChosenBy: 'run' });
    expect(resolveRunRouting({ provider: 'claude' }, { verifiers: [{ provider: 'copilot' }], relaxExclusions: true }, d).verifiers)
      .toEqual([{ provider: 'copilot' }]);
  });

  it('checks a legacy alias under both the id chosen and the CLI that actually runs', () => {
    expect(() => resolveRunRouting({}, { verifiers: [{ provider: 'gemini' }] }, deps({ excluded: ['antigravity'] })))
      .toThrow('Plan Queue checker: antigravity is on the "never auto-pick these providers" list');
    expect(() => resolveRunRouting({}, { worker: { provider: 'gemini' } }, deps({ excluded: ['gemini'] })))
      .toThrow('Plan Queue worker: gemini is on the "never auto-pick these providers" list');
    expect(() => resolveRunRouting({ provider: 'gemini' }, undefined, deps({ excluded: ['gemini'] })))
      .toThrow('Plan Queue worker: gemini is on the "never auto-pick these providers" list');
    expect(resolveRunRouting({}, { worker: { provider: 'openai' } }, deps()).worker).toEqual({ provider: 'codex' });
    expect(resolveRunRouting({ provider: 'auto' }, undefined, deps({ defaultProvider: 'gemini' })).worker).toEqual({ provider: 'antigravity' });
  });

  it('refuses a worker or checker on the never-auto-pick list', () => {
    const d = deps({ excluded: ['copilot'] });
    expect(() => resolveRunRouting({}, { worker: { provider: 'copilot' } }, d))
      .toThrow('Plan Queue worker: copilot is on the "never auto-pick these providers" list');
    expect(() => resolveRunRouting({}, { verifiers: [{ provider: 'copilot' }] }, d))
      .toThrow('Plan Queue checker: copilot is on the "never auto-pick these providers" list');
  });

  it.each([
    [{ worker: { provider: 'nope' } }, 'Plan Queue worker: "nope" is not a provider the queue can use here'],
    [{ verifiers: [{ provider: 'ollama' }] }, 'Plan Queue checker: "ollama" is not a provider the queue can use here'],
    [{ worker: { provider: 'cursor', accountProfileIds: ['x'] } }, 'cursor has no account pool'],
    [{ worker: { provider: 'claude', accountProfileIds: ['missing'] } }, 'there is no claude account "missing"'],
    [{ worker: { provider: 'claude', accountProfileIds: ['pro-1'] } }, 'there is no claude account "pro-1"'],
    [{ worker: { provider: 'claude', accountProfileIds: ['manual'] } }, 'the claude account "manual" is set to "manual only" for automatic work'],
    [{ verifiers: [{ provider: 'codex', copilotProfileId: 'personal' }] }, 'a Copilot account was chosen for codex'],
    [{ verifiers: [{ provider: 'copilot', copilotProfileId: 'work' }] }, 'the Copilot account "work" is set to "manual only"'],
    [{ verifiers: [{ provider: 'copilot', copilotProfileId: 'gone' }] }, 'there is no Copilot account "gone"'],
    [{ worker: { provider: 'opencode', accountProfileIds: ['mimo'] } }, 'OpenCode accounts only apply to MiMo Token Plan models'],
  ])('refuses %j', (override, message) => {
    const d = deps({
      pool: [pool('pro-1', 'codex'), pool('manual', 'claude', { automationPolicy: 'manual-only' })],
      copilot: [copilot('personal'), copilot('work', { automationPolicy: 'manual-only' })],
    });
    expect(() => resolveRunRouting({ provider: 'claude' }, override, d)).toThrow(message);
  });
});

describe('resolveRunRouting — checkers that could never check the work', () => {
  it('refuses checkers that all share the workers\' provider without a different-maker model', () => {
    expect(() => resolveRunRouting({ provider: 'claude' }, { verifiers: [{ provider: 'claude' }] }, deps()))
      .toThrow('None of the chosen checkers can check this run: they all use claude');
    expect(() => resolveRunRouting({}, { worker: { provider: 'codex' }, verifiers: [{ provider: 'openai' }] }, deps()))
      .toThrow('they all use codex');
  });

  it('accepts a same-provider checker with a model from another maker, or any checker on another provider', () => {
    expect(resolveRunRouting({}, { worker: { provider: 'copilot', model: 'gpt-5.5' }, verifiers: [{ provider: 'copilot', model: 'claude-opus-5' }] }, deps()).verifiers)
      .toHaveLength(1);
    expect(resolveRunRouting({ provider: 'claude' }, { verifiers: [{ provider: 'claude' }, { provider: 'codex' }] }, deps()).verifiers)
      .toHaveLength(2);
    // Worker model unknown at start on a multi-maker provider: the live model decides at verification time.
    expect(resolveRunRouting({}, { worker: { provider: 'copilot' }, verifiers: [{ provider: 'copilot', model: 'claude-opus-5' }] }, deps()).verifiers)
      .toHaveLength(1);
  });

  it('refuses a same-provider checker on a single-maker provider when the workers\' model is not named', () => {
    expect(() => resolveRunRouting({}, { worker: { provider: 'codex' }, verifiers: [{ provider: 'codex', model: 'gpt-5.5' }] }, deps()))
      .toThrow('they all use codex');
    expect(() => resolveRunRouting({}, { worker: { provider: 'claude' }, verifiers: [{ provider: 'claude', model: 'claude-sonnet-5' }] }, deps()))
      .toThrow('they all use claude');
  });

  it('refuses a same-provider OpenCode checker until the workers\' OpenCode model is named', () => {
    expect(() => resolveRunRouting({}, { worker: { provider: 'opencode' }, verifiers: [{ provider: 'opencode', model: 'anthropic/claude-opus-5' }] }, deps()))
      .toThrow('on OpenCode, also name the workers\' model');
    expect(resolveRunRouting({}, { worker: { provider: 'opencode', model: 'openai/gpt-5.5' }, verifiers: [{ provider: 'opencode', model: 'anthropic/claude-opus-5' }] }, deps()).verifiers)
      .toHaveLength(1);
  });

  it('accepts a different-maker checker on Antigravity, which serves Gemini, Claude and GPT models', () => {
    expect(resolveRunRouting({}, { worker: { provider: 'antigravity' }, verifiers: [{ provider: 'gemini', model: 'Claude Opus 4.6 (Thinking)' }] }, deps()).verifiers)
      .toEqual([{ provider: 'antigravity', model: 'Claude Opus 4.6 (Thinking)' }]);
  });

  it('refuses a same-family model on the workers\' provider', () => {
    expect(() => resolveRunRouting({}, { worker: { provider: 'copilot', model: 'gpt-5.5' }, verifiers: [{ provider: 'copilot', model: 'gpt-5.4' }] }, deps()))
      .toThrow('None of the chosen checkers can check this run');
  });
});

describe('resolveRunRouting — the work Copilot seat', () => {
  it('refuses a per-run checker list where a work Copilot rule applies, but not the saved list', () => {
    const saved: PlanQueueRouting = { worker: null, verifiers: [{ provider: 'claude' }] };
    expect(() => resolveRunRouting({ provider: 'codex' }, { verifiers: [{ provider: 'claude' }], workspaceCwd: '/repo' }, deps({ scope: 'protected' })))
      .toThrow('checkers given for one run cannot replace the work seat here');
    expect(() => resolveRunRouting({ provider: 'codex' }, { verifiers: [{ provider: 'claude' }], workspaceCwd: '/repo' }, deps({ scope: 'indeterminate' })))
      .toThrow('cannot replace the work seat');
    expect(resolveRunRouting({ provider: 'codex' }, { workspaceCwd: '/repo' }, deps({ saved, scope: 'protected' })).checkersChosenBy).toBe('saved');
    expect(resolveRunRouting({ provider: 'codex' }, { verifiers: [], workspaceCwd: '/repo' }, deps({ saved, scope: 'protected' })).verifiers).toEqual([]);
    expect(resolveRunRouting({ provider: 'codex' }, { verifiers: [{ provider: 'claude' }], workspaceCwd: '/repo' }, deps()).checkersChosenBy).toBe('run');
  });

  it('says where an inherited provider came from when refusing it', () => {
    expect(() => resolveRunRouting({ provider: 'copilot' }, undefined, deps({ excluded: ['copilot'] })))
      .toThrow('The run took this provider from the session that started it');
    expect(() => resolveRunRouting({ provider: 'auto' }, undefined, deps({ excluded: ['copilot'], defaultProvider: 'copilot' })))
      .toThrow('The run took this provider from the default provider setting');
  });
});

describe('routeQueueSpawn', () => {
  const run = (routing?: PlanQueueRouting) => ({ config: { routing } }) as unknown as PlanQueueRun;
  const spawn = (role: string, extra: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig =>
    ({ metadata: { planQueueRunId: 'run-1', planQueueRole: role }, ...extra }) as InstanceCreateConfig;

  it('keeps every queue session on its provider: no cross-provider failover', () => {
    expect(routeQueueSpawn(spawn('verifier', { provider: 'claude' }), () => run()).failoverProviders).toEqual([]);
    expect(routeQueueSpawn(spawn('worker', { provider: 'claude' }), () => run()).failoverProviders).toEqual([]);
  });

  it('refuses a new worker on a provider added to the never-auto-pick list mid-run, unless the run relaxes it', () => {
    const excluded = (provider: string) => provider === 'antigravity';
    expect(() => routeQueueSpawn(spawn('worker', { provider: 'gemini' }), () => run(), excluded))
      .toThrow('antigravity has been added to the "never auto-pick these providers" list since this run started');
    const relaxed = { config: { relaxSettings: true } } as unknown as PlanQueueRun;
    expect(routeQueueSpawn(spawn('worker', { provider: 'gemini' }), () => relaxed, excluded).accountRouteOrigin).toBe('automation');
    // The verifier is re-checked at selection, not here.
    expect(routeQueueSpawn(spawn('verifier', { provider: 'antigravity' }), () => run(), excluded).accountRouteOrigin).toBe('verification');
  });

  it('passes a non-queue spawn through untouched', () => {
    const config = { displayName: 'x' } as InstanceCreateConfig;
    expect(routeQueueSpawn(config, () => run())).toBe(config);
  });

  it('routes a verifier as verification work and keeps its own accounts', () => {
    expect(routeQueueSpawn(spawn('verifier', { provider: 'claude', allowedAccountProfileIds: ['max-b'] }), () => run({
      worker: { provider: 'codex', accountProfileIds: ['pro-1'] }, verifiers: [],
    }))).toMatchObject({ accountRouteOrigin: 'verification', allowedAccountProfileIds: ['max-b'] });
  });

  it.each(['worker', 'triage'])('fences a %s to the run\'s worker accounts as automatic work', (role) => {
    expect(routeQueueSpawn(spawn(role, { provider: 'codex' }), () => run({
      worker: { provider: 'codex', accountProfileIds: ['pro-1', 'pro-2'] }, verifiers: [],
    }))).toMatchObject({ accountRouteOrigin: 'automation', allowedAccountProfileIds: ['pro-1', 'pro-2'] });
  });

  it('routes a Copilot worker as automatic work too, pinning its chosen account', () => {
    const routed = routeQueueSpawn(spawn('worker', { provider: 'copilot' }), () => run({
      worker: { provider: 'copilot', copilotProfileId: 'personal' }, verifiers: [],
    }));
    expect(routed).toMatchObject({ accountRouteOrigin: 'automation', copilotAccountProfileId: 'personal' });
  });

  it('still routes an older run without recorded routing as automatic work', () => {
    expect(routeQueueSpawn(spawn('worker', { provider: 'claude' }), () => run())).toMatchObject({ accountRouteOrigin: 'automation' });
    expect(routeQueueSpawn(spawn('worker'), () => null).allowedAccountProfileIds).toBeUndefined();
  });

  it('uses one current run snapshot for the worker provider, model and account fence after a change', () => {
    let reads = 0;
    const current = run({ worker: { provider: 'claude', model: 'new-model', accountProfileIds: ['new-account'] }, verifiers: [] });
    const result = routeQueueSpawn(spawn('worker', { provider: 'codex', modelOverride: 'old-model', allowedAccountProfileIds: ['old-account'], copilotAccountProfileId: 'old-seat' }), () => { reads += 1; return current; }, () => false);
    expect(reads).toBe(1);
    expect(result).toMatchObject({ provider: 'claude', modelOverride: 'new-model', allowedAccountProfileIds: ['new-account'] });
    expect(result.copilotAccountProfileId).toBeUndefined();
  });

  it('clears a stale explicit provider and model when the run now routes automatically', () => {
    const current = run({ worker: null, verifiers: [] });
    current.workerProvider = null;
    const result = routeQueueSpawn(spawn('worker', { provider: 'codex', modelOverride: 'old' }), () => current);
    expect(result.provider).toBeUndefined();
    expect(result.modelOverride).toBeUndefined();
  });

  it('keeps a triage retry on the selected checker accounts rather than worker accounts', () => {
    const config = spawn('triage', { provider: 'claude', allowedAccountProfileIds: ['checker-account'] });
    config.metadata = { ...config.metadata, planQueueTriageRetry: true };
    expect(routeQueueSpawn(config, () => run({ worker: { provider: 'codex', accountProfileIds: ['worker-account'] }, verifiers: [] }))).toMatchObject({ provider: 'claude', allowedAccountProfileIds: ['checker-account'] });
  });

});

describe('helpers', () => {
  it('maps tool arguments, dropping duplicate and empty account lists', () => {
    expect(routeChoiceFromArgs({ provider: 'claude', account_ids: ['a', 'a', 'b'], copilot_account_id: 'p' }))
      .toEqual({ provider: 'claude', accountProfileIds: ['a', 'b'], copilotProfileId: 'p' });
    expect(routeChoiceFromArgs({ provider: 'codex', account_ids: [] })).toEqual({ provider: 'codex' });
  });

  it('describes routing in one line per role', () => {
    expect(describeRouting({ worker: { provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-1'] }, verifiers: [] }))
      .toEqual({ workers: 'codex / gpt-6.1-sol (accounts: pro-1)', checkers: 'automatic' });
    expect(describeRouting({ worker: null, verifiers: [{ provider: 'claude' }, { provider: 'copilot', copilotProfileId: 'p' }] }))
      .toEqual({ workers: 'the default provider', checkers: 'claude; copilot (account: p)' });
  });
});

describe('route choice schemas', () => {
  it('refuse a misspelt account key instead of silently dropping the fence', () => {
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', worker: { provider: 'claude', accounts: ['max-a'] } }).success).toBe(false);
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', worker: { provider: 'claude', account_ids: ['max-a'] } }).success).toBe(true);
    expect(PlanQueueRoutingSchema.safeParse({ worker: { provider: 'claude', accountIds: ['x'] }, verifiers: [] }).success).toBe(false);
  });
});
