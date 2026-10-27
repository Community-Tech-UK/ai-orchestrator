import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueAccountRules } from '@contracts/schemas/plan-queue';
import { automationAccountPreferences, type AutomationAccountRulesDeps } from './automation-account-rules';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ai-orchestrator-test' } }));

const wiring = vi.hoisted(() => ({
  settings: { defaultCli: 'codex', planQueueAccountRules: undefined as unknown },
  resolveCliType: vi.fn(async () => 'codex'),
}));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => wiring.settings }) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: wiring.resolveCliType }));

const RULES: PlanQueueAccountRules = {
  // The same id under two providers: pool and Copilot ids are separate namespaces.
  never: [{ provider: 'claude', accountId: 'suas' }, { provider: 'copilot', accountId: 'suas' }],
  last: [{ provider: 'claude', accountId: 'spare' }, { provider: 'codex', accountId: 'pro-2' }],
};

function deps(rules: PlanQueueAccountRules, resolved = 'claude'): AutomationAccountRulesDeps & { resolveProvider: ReturnType<typeof vi.fn> } {
  return { readRules: () => rules, resolveProvider: vi.fn(async () => resolved) };
}

describe('automationAccountPreferences', () => {
  it('carries nothing, and resolves no provider, when no account has a rule', async () => {
    const d = deps({ never: [], last: [] });
    await expect(automationAccountPreferences({ provider: 'claude', modelOverride: undefined }, undefined, d)).resolves.toBeUndefined();
    expect(d.resolveProvider).not.toHaveBeenCalled();
  });

  it('gives an Auto automation the lists for the provider it resolves to, and only that provider', async () => {
    const d = deps(RULES, 'claude');
    await expect(automationAccountPreferences({ provider: undefined, modelOverride: undefined }, undefined, d))
      .resolves.toEqual({ avoid: ['suas'], last: ['spare'] });
    expect(d.resolveProvider).toHaveBeenCalledWith(undefined);
  });

  it('uses the Copilot lists for a session that resolves to Copilot', async () => {
    await expect(automationAccountPreferences({ provider: 'copilot', modelOverride: undefined }, undefined, deps(RULES, 'copilot')))
      .resolves.toEqual({ avoid: ['suas'], last: [] });
  });

  it('follows a named provider that falls back to another CLI, as instance creation does', async () => {
    const d = deps(RULES, 'codex');
    await expect(automationAccountPreferences({ provider: 'gemini', modelOverride: undefined }, undefined, d))
      .resolves.toEqual({ avoid: [], last: ['pro-2'] });
    expect(d.resolveProvider).toHaveBeenCalledWith('gemini');
  });

  it('keeps a named provider on a forced worker node without resolving it locally', async () => {
    const d = deps(RULES, 'codex');
    await expect(automationAccountPreferences({ provider: 'claude', modelOverride: undefined }, 'windows-pc', d))
      .resolves.toEqual({ avoid: ['suas'], last: ['spare'] });
    expect(d.resolveProvider).not.toHaveBeenCalled();
  });

  it('carries empty lists when the rules name only other providers\' accounts, so a provider move still follows them', async () => {
    await expect(automationAccountPreferences({ provider: 'opencode', modelOverride: undefined }, undefined, deps(RULES, 'opencode')))
      .resolves.toEqual({ avoid: [], last: [] });
  });

  describe('reading the saved rules and default provider', () => {
    it('reads planQueueAccountRules and resolves the provider with the defaultCli setting', async () => {
      wiring.settings.planQueueAccountRules = RULES;
      await expect(automationAccountPreferences({ provider: 'auto', modelOverride: undefined }, undefined))
        .resolves.toEqual({ avoid: [], last: ['pro-2'] });
      expect(wiring.resolveCliType).toHaveBeenCalledWith('auto', 'codex');
    });

    it('carries nothing when the setting has never been saved', async () => {
      wiring.settings.planQueueAccountRules = undefined;
      await expect(automationAccountPreferences({ provider: 'claude', modelOverride: undefined }, undefined)).resolves.toBeUndefined();
    });
  });
});
