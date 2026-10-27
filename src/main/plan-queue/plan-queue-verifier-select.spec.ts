import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/config/settings-manager', () => ({
  // No account rules, no account profiles: the account-rule defaults read these and nothing else.
  getSettingsManager: () => ({
    getAll: () => ({ planQueueAccountRules: { never: [], last: [] }, providerAccountProfiles: [], copilotAccountProfiles: [], copilotAccountRoutingRules: [] }),
  }),
}));

vi.mock('../providers/automation-provider-exclusions', () => ({
  filterProvidersForAutomation: (providers: string[]) => providers.filter((p) => !excluded.has(p)),
  isProviderExcludedFromAutomation: (provider: string) => excluded.has(provider),
}));

let excluded = new Set<string>();
const openScope = () => ({ kind: 'open' }) as never;

import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import { ANTIGRAVITY_REVIEW_FALLBACK_MODELS } from '../orchestration/antigravity-review-model-routing';
import { selectPlanQueueVerifier } from './plan-queue-verifier-select';

beforeEach(() => {
  excluded = new Set();
});

describe('selectPlanQueueVerifier', () => {
  const base = { workingDirectory: '/repo' };

  it('never picks the worker provider', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex' },
      { listInstalledProviders: async () => ['codex', 'claude'], classifyScope: openScope, resolveProviderModel: () => undefined },
    );
    expect(result).toEqual({ ok: true, choice: { provider: 'claude' } });
  });

  it('passes an unchanged checker its configured reviewer model, so its session cannot inherit another', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex' },
      {
        listInstalledProviders: async () => ['codex', 'claude'],
        classifyScope: openScope,
        resolveProviderModel: (provider) => (provider === 'claude' ? 'sonnet' : undefined),
      },
    );
    expect(result).toEqual({ ok: true, choice: { provider: 'claude', modelOverride: 'sonnet' } });
  });

  it('gives an unchanged Antigravity checker the model a review would use, quota fallback included', async () => {
    const gemini = 'Gemini 3.5 Flash (Medium)';
    const window = (id: string, label: string, used: number) => ({
      kind: 'rolling-window' as const, id, label, unit: 'requests' as const, used, limit: 100, remaining: 100 - used, resetsAt: null,
    });
    const quota = (geminiUsed: number) => (): ProviderQuotaSnapshot => ({
      provider: 'antigravity', takenAt: Date.now(), source: 'admin-api', ok: true,
      windows: [window('antigravity.gemini-5h', 'Gemini · 5-hour', geminiUsed), window('antigravity.3p-5h', 'Claude/GPT · 5-hour', 0)],
    });
    const select = (antigravityQuota: () => ProviderQuotaSnapshot | null) => selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex' },
      { listInstalledProviders: async () => ['codex', 'antigravity'], classifyScope: openScope, resolveProviderModel: () => gemini, antigravityQuota },
    );
    expect(await select(() => null)).toEqual({ ok: true, choice: { provider: 'antigravity', modelOverride: gemini } });
    expect(await select(quota(20))).toEqual({ ok: true, choice: { provider: 'antigravity', modelOverride: gemini } });
    expect(await select(quota(100))).toEqual({ ok: true, choice: { provider: 'antigravity', modelOverride: ANTIGRAVITY_REVIEW_FALLBACK_MODELS.SONNET } });

    // A Claude worker never gets the Claude quota fallback as its checker.
    const forClaudeWorker = (thirdPartyUsed: number) => selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude', workerModel: 'claude-opus-5' },
      {
        listInstalledProviders: async () => ['claude', 'antigravity'], classifyScope: openScope, resolveProviderModel: () => gemini,
        antigravityQuota: (): ProviderQuotaSnapshot => ({
          provider: 'antigravity', takenAt: Date.now(), source: 'admin-api', ok: true,
          windows: [window('antigravity.gemini-5h', 'Gemini · 5-hour', 100), window('antigravity.3p-5h', 'Claude/GPT · 5-hour', thirdPartyUsed)],
        }),
      },
    );
    expect(await forClaudeWorker(0)).toEqual({ ok: true, choice: { provider: 'antigravity', modelOverride: ANTIGRAVITY_REVIEW_FALLBACK_MODELS.GPT_OSS } });
    expect(await forClaudeWorker(100)).toEqual({ ok: true, choice: { provider: 'antigravity', modelOverride: gemini } });
  });

  it('prefers codex for a claude worker', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { listInstalledProviders: async () => ['claude', 'copilot', 'codex'], classifyScope: openScope, resolveProviderModel: () => undefined },
    );
    expect(result.ok && result.choice.provider).toBe('codex');
  });

  it('refuses rather than falling back to the worker provider', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { listInstalledProviders: async () => ['claude'], classifyScope: openScope },
    );
    expect(result.ok).toBe(false);
  });

  it('honours the automation exclusion list', async () => {
    excluded = new Set(['copilot']);
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { listInstalledProviders: async () => ['claude', 'copilot'], classifyScope: openScope },
    );
    expect(result.ok).toBe(false);
  });

  it('parks when the licence scope blocks checking', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      {
        listInstalledProviders: async () => ['claude', 'codex'],
        classifyScope: () => ({ kind: 'indeterminate', reason: 'routing unavailable' }) as never,
      },
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('licence boundary') });
  });
});

describe('selectPlanQueueVerifier — James\'s checker choices', () => {
  const base = { workingDirectory: '/repo' };
  const noScope = () => ({ kind: 'none' }) as never;
  const workScope = () => ({ kind: 'protected', profileId: 'work', profileLabel: 'WORK', accountKind: 'enterprise', automationPolicy: 'allow-routed' }) as never;
  const deps = { classifyScope: noScope, resolveProviderModel: () => undefined, routeUsage: async () => ({ usable: true, resumeAt: null }) };

  it('uses the first chosen checker that can run, with its model and accounts', async () => {
    const result = await selectPlanQueueVerifier(
      {
        ...base,
        workerProvider: 'codex',
        choices: [
          { provider: 'cursor' },
          { provider: 'claude', model: 'claude-opus-5', accountProfileIds: ['max-b'] },
          { provider: 'copilot' },
        ],
      },
      { ...deps, listInstalledProviders: async () => ['codex', 'claude', 'copilot'] },
    );
    expect(result).toEqual({
      ok: true,
      choice: { provider: 'claude', modelOverride: 'claude-opus-5', accountProfileIds: ['max-b'] },
    });
  });

  it('gives a chosen checker without a model its configured reviewer model', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex', choices: [{ provider: 'claude' }] },
      { ...deps, resolveProviderModel: (provider: string) => (provider === 'claude' ? 'sonnet' : undefined), listInstalledProviders: async () => ['codex', 'claude'] },
    );
    expect(result).toEqual({ ok: true, choice: { provider: 'claude', modelOverride: 'sonnet' } });
  });

  it('skips a chosen checker with no usage left, else waits on the one whose limit lifts soonest', async () => {
    const choices = [{ provider: 'claude' }, { provider: 'cursor' }, { provider: 'copilot' }];
    const installed = async () => ['codex', 'claude', 'cursor', 'copilot'];
    const usage = (table: Record<string, { usable: boolean; resumeAt: number | null }>) =>
      async (choice: { provider: string }, origin: string) => {
        expect(origin).toBe('verification');
        return table[choice.provider]!;
      };
    expect(await selectPlanQueueVerifier({ ...base, workerProvider: 'codex', choices }, {
      ...deps, listInstalledProviders: installed,
      routeUsage: usage({ claude: { usable: false, resumeAt: 10 }, cursor: { usable: true, resumeAt: null }, copilot: { usable: true, resumeAt: null } }),
    })).toEqual({ ok: true, choice: { provider: 'cursor' } });
    expect(await selectPlanQueueVerifier({ ...base, workerProvider: 'codex', choices }, {
      ...deps, listInstalledProviders: installed,
      routeUsage: usage({ claude: { usable: false, resumeAt: 90 }, cursor: { usable: false, resumeAt: null }, copilot: { usable: false, resumeAt: 30 } }),
    })).toEqual({ ok: true, choice: { provider: 'copilot' } });
  });

  it('lets James\'s saved list replace the licence-pinned work Copilot seat', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex', choices: [{ provider: 'claude' }], choicesOverrideLicence: true },
      { listInstalledProviders: async () => ['codex', 'claude', 'copilot'], resolveProviderModel: () => undefined, classifyScope: workScope },
    );
    expect(result).toEqual({ ok: true, choice: { provider: 'claude' } });
  });

  it('gives a saved Copilot checker in a work folder one of the seat\'s own models', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex', workerModel: 'gpt-5.5', choices: [{ provider: 'copilot' }], choicesOverrideLicence: true },
      { listInstalledProviders: async () => ['codex', 'copilot'], resolveProviderModel: () => 'gpt-5.5', classifyScope: workScope, isModelUnavailable: () => false },
    );
    expect(result).toMatchObject({ ok: true, choice: { provider: 'copilot', modelOverride: expect.stringMatching(/claude|grok|gemini/) } });
  });

  it('keeps the work Copilot seat when a per-run list would take work code off it', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex', workerModel: 'gpt-5.5', choices: [{ provider: 'claude' }] },
      { listInstalledProviders: async () => ['codex', 'claude', 'copilot'], resolveProviderModel: () => undefined, classifyScope: workScope },
    );
    expect(result).toMatchObject({ ok: true, choice: { provider: 'copilot', copilotProfileId: 'work' } });
  });

  it('does not let a per-run list bypass an unresolvable licence scope', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex', choices: [{ provider: 'claude' }] },
      {
        listInstalledProviders: async () => ['codex', 'claude'],
        classifyScope: () => ({ kind: 'indeterminate', reason: 'routing unavailable' }) as never,
      },
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('licence boundary') });
  });

  it('passes a chosen Copilot account through', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex', choices: [{ provider: 'copilot', copilotProfileId: 'personal' }] },
      { ...deps, listInstalledProviders: async () => ['codex', 'copilot'] },
    );
    expect(result).toEqual({ ok: true, choice: { provider: 'copilot', copilotProfileId: 'personal' } });
  });

  it('skips the worker\'s provider unless a different-family model was chosen', async () => {
    const same = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'copilot', workerModel: 'gpt-5.5', choices: [{ provider: 'copilot' }] },
      { ...deps, listInstalledProviders: async () => ['copilot'] },
    );
    expect(same).toEqual({ ok: false, reason: expect.stringContaining('copilot is the worker\'s provider') });

    const diverse = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'copilot', workerModel: 'gpt-5.5', choices: [{ provider: 'copilot', model: 'claude-opus-5' }] },
      { ...deps, listInstalledProviders: async () => ['copilot'] },
    );
    expect(diverse).toEqual({ ok: true, choice: { provider: 'copilot', modelOverride: 'claude-opus-5' } });
  });

  it('applies the start check\'s rule when the worker\'s live model is unknown', async () => {
    const copilot = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'copilot', workerModel: null, choices: [{ provider: 'copilot', model: 'claude-opus-5' }] },
      { ...deps, listInstalledProviders: async () => ['copilot'] },
    );
    expect(copilot).toEqual({ ok: true, choice: { provider: 'copilot', modelOverride: 'claude-opus-5' } });

    const opencode = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'opencode', workerModel: null, choices: [{ provider: 'opencode', model: 'anthropic/claude-opus-5' }] },
      { ...deps, listInstalledProviders: async () => ['opencode'] },
    );
    expect(opencode.ok).toBe(false);
  });

  it('parks with every reason when none of the choices can run, never falling back to automatic selection', async () => {
    excluded = new Set(['copilot']);
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude', choices: [{ provider: 'cursor' }, { provider: 'copilot' }] },
      { ...deps, listInstalledProviders: async () => ['claude', 'codex', 'copilot'] },
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('cursor is not installed; copilot is on the "never auto-pick" list') });
  });
});

describe('selectPlanQueueVerifier: account rules', () => {
  const base = { workingDirectory: '/repo' };
  const pool = (id: string, provider: string) => ({ id, provider, label: `Label ${id}`, enabled: true, automationPolicy: 'allow-routed' }) as never;
  const accounts = (never: { provider: string; accountId: string }[], last: { provider: string; accountId: string }[] = [], seat: string | null = null) => ({
    readAccountRules: () => ({ never, last }) as never,
    poolProfiles: () => [pool('pro-2', 'codex'), pool('pro-1', 'codex')],
    copilotProfiles: () => [{ id: 'work', label: 'Work seat', automationPolicy: 'allow-routed' } as never],
    copilotProfileFor: () => seat,
  });
  // An unprotected folder ('none') lets a saved or per-run checker list decide, as in the choice tests above.
  const common = { classifyScope: () => ({ kind: 'none' }) as never, resolveProviderModel: () => undefined };

  it('skips a saved checker whose only account is on the never-use list', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude', choices: [{ provider: 'codex', accountProfileIds: ['pro-2'] }, { provider: 'copilot' }] },
      { ...common, listInstalledProviders: async () => ['claude', 'codex', 'copilot'], accountRules: accounts([{ provider: 'codex', accountId: 'pro-2' }]) },
    );
    expect(result.ok && result.choice.provider).toBe('copilot');
  });

  it('reports the never-use reason when every saved checker is refused by the rules', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude', choices: [{ provider: 'codex', accountProfileIds: ['pro-2'] }] },
      { ...common, listInstalledProviders: async () => ['claude', 'codex'], accountRules: accounts([{ provider: 'codex', accountId: 'pro-2' }]) },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'none of the checkers chosen for this run can check it: codex: the codex account "Label pro-2" is on your never-use list',
    });
  });

  it('parks with the seat reason when the only automatic checker is a Copilot seat on the never-use list', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { ...common, listInstalledProviders: async () => ['claude', 'copilot'], accountRules: accounts([{ provider: 'copilot', accountId: 'work' }], [], 'work') },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'the work Copilot seat for this folder is on your never-use list; choose checkers on the Plan Queue page',
    });
  });

  it('keeps a saved checker that still has an allowed account when one of its accounts is on the never-use list', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude', choices: [{ provider: 'codex', accountProfileIds: ['pro-1', 'pro-2'] }] },
      { ...common, listInstalledProviders: async () => ['claude', 'codex'], accountRules: accounts([{ provider: 'codex', accountId: 'pro-2' }]) },
    );
    expect(result).toEqual({ ok: true, choice: { provider: 'codex', accountProfileIds: ['pro-1'] } });
  });

  it('puts an automatic Copilot checker on a use-last seat behind the other checkers', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { ...common, listInstalledProviders: async () => ['claude', 'copilot', 'cursor'], accountRules: accounts([], [{ provider: 'copilot', accountId: 'work' }], 'work') },
    );
    expect(result.ok && result.choice.provider).toBe('cursor');
  });

  it('moves an automatic checker whose only usable account is use-last behind the others', async () => {
    const routeUsage = vi.fn(async (choice: { provider: string }, _origin: string, options: { allowLast: boolean }) => ({
      usable: choice.provider !== 'codex' || options.allowLast, resumeAt: null,
    }));
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { ...common, listInstalledProviders: async () => ['claude', 'codex', 'copilot'], accountRules: accounts([], [{ provider: 'codex', accountId: 'pro-2' }]), routeUsage },
    );
    expect(result.ok && result.choice.provider).toBe('copilot');
    expect(routeUsage).toHaveBeenCalledWith({ provider: 'codex' }, 'verification', { allowLast: false, workingDirectory: '/repo' });
  });
});
