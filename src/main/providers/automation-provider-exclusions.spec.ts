import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  excluded: undefined as unknown,
  throwOnRead: false,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => {
      if (state.throwOnRead) throw new Error('settings unavailable');
      return { providersExcludedFromAutomation: state.excluded };
    },
  }),
}));

import {
  getProvidersExcludedFromAutomation,
  isProviderExcludedFromAutomation,
  filterProvidersForAutomation,
  _resetAutomationProviderExclusionsForTesting,
} from './automation-provider-exclusions';

describe('automation provider exclusions', () => {
  beforeEach(() => {
    state.excluded = [];
    state.throwOnRead = false;
    _resetAutomationProviderExclusionsForTesting();
  });

  describe('getProvidersExcludedFromAutomation', () => {
    it('is empty by default so nothing is restricted', () => {
      expect(getProvidersExcludedFromAutomation().size).toBe(0);
    });

    it('normalizes case and surrounding whitespace', () => {
      state.excluded = ['  CoPilot  '];
      expect([...getProvidersExcludedFromAutomation()]).toEqual(['copilot']);
    });

    it('ignores empty and non-string entries rather than throwing', () => {
      state.excluded = ['copilot', '', '   ', 42, null, undefined];
      expect([...getProvidersExcludedFromAutomation()]).toEqual(['copilot']);
    });

    it('tolerates a non-array value', () => {
      state.excluded = 'copilot';
      expect(getProvidersExcludedFromAutomation().size).toBe(0);
    });
  });

  describe('fail-safe behaviour', () => {
    it('keeps enforcing the last known list when the settings read throws', () => {
      state.excluded = ['copilot'];
      expect(isProviderExcludedFromAutomation('copilot')).toBe(true);

      state.throwOnRead = true;
      // A transient settings failure must NOT silently re-admit the provider.
      expect(isProviderExcludedFromAutomation('copilot')).toBe(true);
    });

    it('returns empty when the read fails before any successful read', () => {
      state.throwOnRead = true;
      expect(getProvidersExcludedFromAutomation().size).toBe(0);
    });
  });

  describe('isProviderExcludedFromAutomation', () => {
    it('matches regardless of candidate case and whitespace', () => {
      state.excluded = ['copilot'];
      expect(isProviderExcludedFromAutomation('COPILOT')).toBe(true);
      expect(isProviderExcludedFromAutomation(' copilot ')).toBe(true);
    });

    it('does not match a provider that was not listed', () => {
      state.excluded = ['copilot'];
      expect(isProviderExcludedFromAutomation('claude')).toBe(false);
    });

    it('does not fold the gemini/antigravity reviewer alias', () => {
      // They are distinct CLIs (`gemini` vs `agy`); excluding one must not
      // silently exclude the other.
      state.excluded = ['gemini'];
      expect(isProviderExcludedFromAutomation('antigravity')).toBe(false);
      state.excluded = ['antigravity'];
      expect(isProviderExcludedFromAutomation('gemini')).toBe(false);
    });
  });

  describe('filterProvidersForAutomation', () => {
    it('returns the list unchanged when nothing is excluded', () => {
      expect(filterProvidersForAutomation(['claude', 'codex'], 'test')).toEqual(['claude', 'codex']);
    });

    it('drops excluded providers and preserves the order of the rest', () => {
      state.excluded = ['copilot'];
      expect(
        filterProvidersForAutomation(['claude', 'codex', 'copilot', 'cursor'], 'test'),
      ).toEqual(['claude', 'codex', 'cursor']);
    });

    it('can drop every candidate, leaving the caller to handle an empty list', () => {
      state.excluded = ['claude', 'copilot'];
      expect(filterProvidersForAutomation(['claude', 'copilot'], 'test')).toEqual([]);
    });

    it('returns a copy so callers cannot mutate the source preference array', () => {
      const source = ['claude', 'codex'] as const;
      const filtered = filterProvidersForAutomation(source, 'test');
      expect(filtered).not.toBe(source);
      expect(filtered).toEqual(['claude', 'codex']);
    });
  });
});
