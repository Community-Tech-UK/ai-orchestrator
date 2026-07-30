import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `resolveCliType` is the catch-all for every `provider: 'auto'` spawn, so it is
 * the last line of defence for a provider the operator barred from automatic
 * selection — and equally the place where an over-broad filter would break an
 * explicit user choice. Both directions are asserted here.
 */

const state = vi.hoisted(() => ({
  excluded: [] as string[],
  available: [] as string[],
}));

vi.mock('../../cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({
      detectAll: async () => ({
        available: state.available.map((name) => ({ name })),
      }),
    }),
  },
}));
vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ providersExcludedFromAutomation: state.excluded }),
  }),
}));

import { resolveCliType } from '../adapter-factory';
import { _resetAutomationProviderExclusionsForTesting } from '../../../providers/automation-provider-exclusions';

describe('resolveCliType — automation provider exclusions', () => {
  beforeEach(() => {
    state.excluded = [];
    state.available = ['claude', 'codex', 'copilot', 'cursor'];
    _resetAutomationProviderExclusionsForTesting();
  });

  describe('the auto-detect fallback', () => {
    it('picks an excluded provider when nothing is excluded', async () => {
      state.available = ['copilot'];
      await expect(resolveCliType('auto', 'auto')).resolves.toBe('copilot');
    });

    it('skips an excluded provider and takes the next available one', async () => {
      state.excluded = ['copilot'];
      state.available = ['copilot', 'cursor'];
      await expect(resolveCliType('auto', 'auto')).resolves.toBe('cursor');
    });

    it('falls back to claude when every available provider is excluded', async () => {
      // Documents the existing no-CLI-detected behaviour rather than inventing
      // a new failure mode: the caller surfaces the spawn error downstream.
      state.excluded = ['copilot', 'cursor'];
      state.available = ['copilot', 'cursor'];
      await expect(resolveCliType('auto', 'auto')).resolves.toBe('claude');
    });
  });

  describe('explicit selection is never filtered', () => {
    it('honours an explicitly requested provider even when it is excluded', async () => {
      // This is the whole point of the setting: James picking Copilot for a
      // session in his EBRD folder must still work.
      state.excluded = ['copilot'];
      state.available = ['claude', 'copilot'];
      await expect(resolveCliType('copilot', 'auto')).resolves.toBe('copilot');
    });

    it('honours an excluded provider set as the defaultCli', async () => {
      state.excluded = ['copilot'];
      state.available = ['claude', 'copilot'];
      await expect(resolveCliType('auto', 'copilot')).resolves.toBe('copilot');
    });
  });
});
