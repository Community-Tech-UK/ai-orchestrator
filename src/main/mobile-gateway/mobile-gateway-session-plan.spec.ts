import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the host-side dependencies (settings, CLI auto-detect, model validation)
// so the test controls their inputs; the model-resolution + label logic under
// test (resolveInitialModel, tier/validation, provider + effort labels) runs
// for real.
const { getAll, resolveCliType, getKnownModelsForCli } = vi.hoisted(() => ({
  getAll: vi.fn(),
  resolveCliType: vi.fn(),
  getKnownModelsForCli: vi.fn(),
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

import { resolveMobileSessionPlan } from './mobile-gateway-session-plan';

function settings(overrides: Record<string, unknown> = {}) {
  return { defaultCli: 'auto', defaultModel: '', defaultModelByProvider: {}, ...overrides };
}

describe('resolveMobileSessionPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAll.mockReturnValue(settings());
    getKnownModelsForCli.mockResolvedValue([]);
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
});
