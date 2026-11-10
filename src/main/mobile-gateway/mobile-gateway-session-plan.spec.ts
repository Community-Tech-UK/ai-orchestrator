import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the host-side dependencies (settings, CLI auto-detect, model validation)
// so the test controls their inputs; the model-resolution + label logic under
// test (resolveInitialModel, tier/validation, provider + effort labels) runs
// for real.
const { getAll, resolveCliType, getKnownModelsForCli, listProfiles, preview } = vi.hoisted(() => ({
  getAll: vi.fn(),
  resolveCliType: vi.fn(),
  getKnownModelsForCli: vi.fn(),
  listProfiles: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll }),
}));
vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType,
}));
vi.mock('../instance/lifecycle/create-validation-helpers', () => ({
  getKnownModelsForCli,
}));
vi.mock('../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ listProfiles }),
}));
vi.mock('../providers/account-pool/provider-account-routing-service', () => ({
  getProviderAccountRoutingService: () => ({ preview }),
}));

import { resolveMobileSessionPlan } from './mobile-gateway-session-plan';

function settings(overrides: Record<string, unknown> = {}) {
  return { defaultCli: 'auto', defaultModel: '', defaultModelByProvider: {}, ...overrides };
}

describe('resolveMobileSessionPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAll.mockReturnValue(settings());
    getKnownModelsForCli.mockResolvedValue([]);
    listProfiles.mockReturnValue([]);
  });

  it('auto -> resolved provider label, provider-default model, provider thinking', async () => {
    resolveCliType.mockResolvedValue('claude');
    const plan = await resolveMobileSessionPlan({ provider: 'auto' });
    expect(plan.provider).toBe('claude');
    expect(plan.providerLabel).toBe('Claude');
    // No remembered/global model, so the provider uses its built-in default.
    expect(plan.model).toBeNull();
    expect(plan.modelLabel).toBeNull();
    expect(plan.reasoningEffort).toBe('high');
    expect(plan.reasoningEffortLabel).toBe('High');
  });

  it('surfaces the per-provider remembered model with a human label', async () => {
    resolveCliType.mockResolvedValue('claude');
    getAll.mockReturnValue(settings({ defaultModelByProvider: { claude: 'my-model-x' } }));
    getKnownModelsForCli.mockResolvedValue(['my-model-x']);
    const plan = await resolveMobileSessionPlan({ provider: 'auto' });
    expect(plan.model).toBe('my-model-x');
    expect(typeof plan.modelLabel).toBe('string');
    expect(plan.modelLabel).toBeTruthy();
  });

  it('an explicit model override wins over settings', async () => {
    resolveCliType.mockResolvedValue('claude');
    getAll.mockReturnValue(settings({ defaultModelByProvider: { claude: 'remembered' } }));
    getKnownModelsForCli.mockResolvedValue(['remembered', 'chosen']);
    const plan = await resolveMobileSessionPlan({ provider: 'claude', model: 'chosen' });
    expect(plan.model).toBe('chosen');
  });

  it('codex defaults to high thinking', async () => {
    resolveCliType.mockResolvedValue('codex');
    const plan = await resolveMobileSessionPlan({ provider: 'codex' });
    expect(plan.provider).toBe('codex');
    expect(plan.providerLabel).toBe('Codex');
    expect(plan.reasoningEffort).toBe('high');
    expect(plan.reasoningEffortLabel).toBe('High');
  });

  it('uses an explicit mobile reasoning override in the preview', async () => {
    resolveCliType.mockResolvedValue('codex');
    const plan = await resolveMobileSessionPlan({ provider: 'codex', reasoningEffort: 'xhigh' });
    expect(plan.reasoningEffort).toBe('xhigh');
    expect(plan.reasoningEffortLabel).toBe('Extra high');
  });

  it('a provider without an app-level default reports null thinking', async () => {
    resolveCliType.mockResolvedValue('gemini');
    const plan = await resolveMobileSessionPlan({ provider: 'gemini' });
    expect(plan.reasoningEffort).toBeNull();
    expect(plan.reasoningEffortLabel).toBeNull();
  });

  it('degrades a cross-provider / stale model to the provider default instead of leaking it', async () => {
    resolveCliType.mockResolvedValue('codex');
    // A Claude model remembered globally, but Codex got resolved and does not
    // know it — it must fall back rather than pass a foreign model through.
    getAll.mockReturnValue(settings({ defaultModel: 'claude-opus-4' }));
    getKnownModelsForCli.mockResolvedValue(['gpt-5.5']);
    const plan = await resolveMobileSessionPlan({ provider: 'codex' });
    expect(plan.model).not.toBe('claude-opus-4');
  });

  it('names OpenCode "OpenCode" unless the model proves it is the MiMo plan', async () => {
    resolveCliType.mockResolvedValue('opencode');
    getKnownModelsForCli.mockResolvedValue([
      'xiaomi-token-plan-ams/mimo-v2.5-pro',
      'opencode/big-pickle',
      'openrouter/anthropic/claude-sonnet-4',
    ]);

    const generic = await resolveMobileSessionPlan({ provider: 'opencode' });
    expect(generic.providerLabel).toBe('OpenCode');

    const mimo = await resolveMobileSessionPlan({ provider: 'opencode', model: 'xiaomi-token-plan-ams/mimo-v2.5-pro' });
    expect(mimo.model).toBe('xiaomi-token-plan-ams/mimo-v2.5-pro');
    expect(mimo.providerLabel).toBe('MiMo');

    for (const model of ['opencode/big-pickle', 'openrouter/anthropic/claude-sonnet-4']) {
      const other = await resolveMobileSessionPlan({ provider: 'opencode', model });
      expect(other.model).toBe(model);
      expect(other.providerLabel).toBe('OpenCode');
    }
  });

  describe('accounts', () => {
    const profile = (id: string, label: string, priority: number, extra: Record<string, unknown> = {}) =>
      ({ id, label, priority, enabled: true, automationPolicy: 'allow-routed', ...extra });
    const route = (profileId: string, source: string) =>
      ({ outcome: { ok: true, route: { provider: 'claude', profileId, source, executionNodeId: 'local' } }, considered: [] });

    beforeEach(() => {
      resolveCliType.mockResolvedValue('claude');
      listProfiles.mockReturnValue([
        profile('claudeadapt-f899', 'ClaudeAdapt', 2),
        profile('legacy', 'ClaudeSUAS', 0),
        profile('off-account', 'Switched off', 1, { enabled: false }),
        profile('barred-account', 'Barred', 3, { automationPolicy: 'disabled' }),
        profile('claudecomtech-7e12', 'ClaudeComTech', 1),
      ]);
    });

    it('lists usable accounts in priority order with the one Harness would pick', async () => {
      preview.mockResolvedValue(route('legacy', 'default'));
      const plan = await resolveMobileSessionPlan({ provider: 'auto' });
      expect(listProfiles).toHaveBeenCalledWith('claude');
      expect(preview).toHaveBeenCalledWith({ provider: 'claude', model: null, origin: 'interactive' });
      expect(plan.account).toEqual({
        options: [
          { id: 'legacy', label: 'ClaudeSUAS' },
          { id: 'claudecomtech-7e12', label: 'ClaudeComTech' },
          { id: 'claudeadapt-f899', label: 'ClaudeAdapt' },
        ],
        summary: 'ClaudeSUAS · chosen automatically',
      });
    });

    it('previews the chosen account, and ignores one that is not offered', async () => {
      preview.mockResolvedValue(route('claudecomtech-7e12', 'explicit'));
      const chosen = await resolveMobileSessionPlan({ provider: 'claude', accountProfileId: 'claudecomtech-7e12' });
      expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ explicitProfileId: 'claudecomtech-7e12' }));
      expect(chosen.account?.summary).toBe('ClaudeComTech · you chose this account');

      await resolveMobileSessionPlan({ provider: 'claude', accountProfileId: 'off-account' });
      expect(preview.mock.calls.at(-1)?.[0]).not.toHaveProperty('explicitProfileId');
    });

    it('says why when no account can be used, and names a skipped account at its limit', async () => {
      preview.mockResolvedValue({ outcome: { ok: false, code: 'all-profiles-parked', detail: 'Every Claude account is at its limit.' }, considered: [] });
      const blocked = await resolveMobileSessionPlan({ provider: 'claude' });
      expect(blocked.account?.summary).toBe('Every Claude account is at its limit.');

      preview.mockResolvedValue({ ...route('claudecomtech-7e12', 'default'), considered: [{ profileId: 'legacy', vetoReason: 'parked' }] });
      const moved = await resolveMobileSessionPlan({ provider: 'claude' });
      expect(moved.account?.summary).toBe('ClaudeComTech · ClaudeSUAS is at its limit');
    });

    it('offers no choice with fewer than two usable accounts, for other providers, or for non-MiMo OpenCode', async () => {
      listProfiles.mockReturnValue([profile('legacy', 'ClaudeSUAS', 0), profile('off-account', 'Off', 1, { enabled: false })]);
      expect((await resolveMobileSessionPlan({ provider: 'claude' })).account).toBeUndefined();

      resolveCliType.mockResolvedValue('gemini');
      expect((await resolveMobileSessionPlan({ provider: 'gemini' })).account).toBeUndefined();

      resolveCliType.mockResolvedValue('opencode');
      listProfiles.mockReturnValue([profile('legacy', 'SuasMimo', 0), profile('comtechspare-f7a6', 'ComTechMimo', 1)]);
      getKnownModelsForCli.mockResolvedValue(['opencode/big-pickle', 'xiaomi-token-plan-ams/mimo-v2.5-pro']);
      expect((await resolveMobileSessionPlan({ provider: 'opencode', model: 'opencode/big-pickle' })).account).toBeUndefined();
      preview.mockResolvedValue(route('legacy', 'default'));
      const mimo = await resolveMobileSessionPlan({ provider: 'opencode', model: 'xiaomi-token-plan-ams/mimo-v2.5-pro' });
      expect(mimo.account?.options.map((option) => option.id)).toEqual(['legacy', 'comtechspare-f7a6']);
      expect(preview).toHaveBeenCalledTimes(1);
    });
  });
});
