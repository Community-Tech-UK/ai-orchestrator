import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providers/automation-provider-exclusions', () => ({
  filterProvidersForAutomation: (providers: string[]) => providers.filter((p) => !excluded.has(p)),
  isProviderExcludedFromAutomation: (provider: string) => excluded.has(provider),
}));

let excluded = new Set<string>();
const openScope = () => ({ kind: 'open' }) as never;

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
  const deps = { classifyScope: noScope, resolveProviderModel: () => undefined };

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
