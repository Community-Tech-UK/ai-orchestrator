import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  excluded: [] as string[],
  resolvable: new Set<string>(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      providersExcludedFromAutomation: state.excluded,
      // Keep Ollama out of the picture; its branch is covered elsewhere.
      auxiliaryLlmUseLocalhostOllama: false,
      auxiliaryLlmQualityModel: '',
    }),
  }),
}));
vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn(async (provider: string) =>
    state.resolvable.has(provider) ? provider : 'claude',
  ),
}));

import { resolveScaffoldingProvider } from './scaffolding-local-provider';
import { _resetAutomationProviderExclusionsForTesting } from '../providers/automation-provider-exclusions';

describe('resolveScaffoldingProvider — automation provider exclusions', () => {
  beforeEach(() => {
    state.excluded = [];
    state.resolvable = new Set(['copilot', 'cursor']);
    _resetAutomationProviderExclusionsForTesting();
  });

  it('routes to copilot when nothing is excluded', async () => {
    await expect(resolveScaffoldingProvider('auto', 'workflow')).resolves.toEqual({
      provider: 'copilot',
    });
  });

  it('skips an excluded provider and takes the next in the preference list', async () => {
    state.excluded = ['copilot'];
    await expect(resolveScaffoldingProvider('auto', 'workflow')).resolves.toEqual({
      provider: 'cursor',
    });
  });

  it('returns undefined when every preference-list candidate is excluded', async () => {
    // The caller (default-invokers) then keeps its original provider rather
    // than steering off Claude, which is the correct no-candidate behaviour.
    state.excluded = ['copilot', 'cursor'];
    await expect(resolveScaffoldingProvider('auto', 'workflow')).resolves.toBeUndefined();
  });
});
