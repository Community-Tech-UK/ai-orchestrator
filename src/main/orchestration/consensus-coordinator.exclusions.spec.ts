import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  excluded: [] as string[],
  available: [] as string[],
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ providersExcludedFromAutomation: state.excluded }),
  }),
}));
vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({
      detectAll: async () => ({ available: state.available.map((name) => ({ name })) }),
    }),
  },
}));

import { ConsensusCoordinator } from './consensus-coordinator';
import type { ConsensusProviderSpec } from './consensus.types';
import { _resetAutomationProviderExclusionsForTesting } from '../providers/automation-provider-exclusions';

/** `resolveProviders` is private; the fan-out list it returns is the behaviour under test. */
function resolveProviders(
  coordinator: ConsensusCoordinator,
  requested?: ConsensusProviderSpec[],
): Promise<ConsensusProviderSpec[]> {
  return (
    coordinator as unknown as {
      resolveProviders(r?: ConsensusProviderSpec[]): Promise<ConsensusProviderSpec[]>;
    }
  ).resolveProviders(requested);
}

describe('consensus provider fan-out — automation exclusions', () => {
  let coordinator: ConsensusCoordinator;

  beforeEach(() => {
    state.excluded = [];
    state.available = ['claude', 'codex', 'copilot', 'cursor'];
    _resetAutomationProviderExclusionsForTesting();
    ConsensusCoordinator._resetForTesting();
    coordinator = ConsensusCoordinator.getInstance();
  });

  describe('default fan-out (no providers requested)', () => {
    it('includes every available provider when nothing is excluded', async () => {
      const resolved = await resolveProviders(coordinator);
      expect(resolved.map((p) => p.provider)).toContain('copilot');
    });

    it('omits an excluded provider', async () => {
      state.excluded = ['copilot'];
      const resolved = await resolveProviders(coordinator);
      expect(resolved.map((p) => p.provider)).toEqual(['claude', 'codex', 'cursor']);
    });
  });

  describe('agent-requested providers', () => {
    it('drops an excluded provider an orchestrator agent asked for by name', async () => {
      // The requested list comes from a consensus_query command, not from a
      // human picking a session provider, so the exclusion applies.
      state.excluded = ['copilot'];
      const resolved = await resolveProviders(coordinator, [
        { provider: 'copilot' },
        { provider: 'codex' },
      ] as ConsensusProviderSpec[]);
      expect(resolved.map((p) => p.provider)).toEqual(['codex']);
    });

    it('leaves a requested non-excluded provider alone', async () => {
      state.excluded = ['copilot'];
      const resolved = await resolveProviders(coordinator, [
        { provider: 'claude' },
      ] as ConsensusProviderSpec[]);
      expect(resolved.map((p) => p.provider)).toEqual(['claude']);
    });
  });

  it('reports no providers available rather than querying an excluded one', async () => {
    state.excluded = ['copilot'];
    state.available = ['copilot'];

    const result = await coordinator.query('anything?');

    expect(result.consensus).toContain('No providers available');
  });
});
