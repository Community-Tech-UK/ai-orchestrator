import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliInfo } from '../cli/cli-detection';

const state = vi.hoisted(() => ({
  excluded: [] as string[],
}));
const createCliProvider = vi.hoisted(() => vi.fn((name: string) => ({ name })));
const createProvider = vi.hoisted(() => vi.fn((type: string) => ({ type })));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ providersExcludedFromAutomation: state.excluded }),
  }),
}));
vi.mock('../providers/provider-instance-manager', () => ({
  getProviderInstanceManager: () => ({
    createCliProvider,
    createProvider,
    getEnabledProviders: () => [],
    isSupported: () => true,
  }),
}));

import { CliVerificationCoordinator } from './cli-verification-extension';
import { _resetAutomationProviderExclusionsForTesting } from '../providers/automation-provider-exclusions';

function cli(name: string): CliInfo {
  return { name, displayName: name, command: name, installed: true } as CliInfo;
}

/** `selectAgents` is private; the panel it assembles is the behaviour under test. */
function selectAgents(
  coordinator: CliVerificationCoordinator,
  config: Record<string, unknown>,
  available: CliInfo[],
): Promise<{ name: string }[]> {
  return (
    coordinator as unknown as {
      selectAgents(c: unknown, a: CliInfo[]): Promise<{ name: string }[]>;
    }
  ).selectAgents(config, available);
}

describe('CLI verification panel — automation provider exclusions', () => {
  let coordinator: CliVerificationCoordinator;
  const available = [cli('gemini'), cli('codex'), cli('copilot'), cli('cursor')];

  beforeEach(() => {
    state.excluded = [];
    _resetAutomationProviderExclusionsForTesting();
    createCliProvider.mockClear();
    createProvider.mockClear();
    CliVerificationCoordinator._resetForTesting();
    coordinator = CliVerificationCoordinator.getInstance();
  });

  describe('auto-selected panel', () => {
    it('reaches copilot at its preference rank when nothing is excluded', async () => {
      await selectAgents(coordinator, { agentCount: 3 }, available);
      expect(createCliProvider.mock.calls.map(([n]) => n)).toEqual(['gemini', 'codex', 'copilot']);
    });

    it('skips an excluded provider and takes the next ranked one', async () => {
      state.excluded = ['copilot'];
      await selectAgents(coordinator, { agentCount: 3 }, available);
      expect(createCliProvider.mock.calls.map(([n]) => n)).toEqual(['gemini', 'codex', 'cursor']);
    });

    it('builds an empty panel when every available provider is excluded', async () => {
      state.excluded = ['gemini', 'codex', 'copilot', 'cursor'];
      const agents = await selectAgents(coordinator, { agentCount: 3 }, available);
      expect(agents).toEqual([]);
    });
  });

  describe('explicitly requested CLI agents', () => {
    it('drops an excluded provider from a requested panel', async () => {
      state.excluded = ['copilot'];
      await selectAgents(
        coordinator,
        { agentCount: 3, cliAgents: ['copilot', 'codex'] },
        available,
      );
      expect(createCliProvider.mock.calls.map(([n]) => n)).toEqual(['codex']);
    });

    it('does not fall back to an API provider for an excluded CLI', async () => {
      // An excluded provider that is not installed would otherwise reach the
      // API-fallback branch, which keys off the same CLI name.
      state.excluded = ['gemini'];
      await selectAgents(
        coordinator,
        { agentCount: 2, cliAgents: ['gemini'], fallbackToApi: true },
        [cli('codex')],
      );
      expect(createCliProvider).not.toHaveBeenCalled();
      expect(createProvider).not.toHaveBeenCalled();
    });
  });
});
