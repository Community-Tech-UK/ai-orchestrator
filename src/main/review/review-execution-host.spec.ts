import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveReviewerModelOverride } from './review-execution-host';

// Mutable holder so each test can configure the per-reviewer model override.
const hostTestState = vi.hoisted(() => ({
  modelByProvider: {} as Record<string, string>,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewModelByProvider: hostTestState.modelByProvider,
    }),
  }),
}));

// The resolver does not use these, but importing review-execution-host pulls
// them in at module load — stub them so the unit spec stays light and isolated.
vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn(),
}));
vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(),
}));

describe('resolveReviewerModelOverride', () => {
  beforeEach(() => {
    hostTestState.modelByProvider = {};
  });

  it('returns undefined when no entry is configured (CLI auto-routes)', () => {
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });

  it('returns undefined for an empty / whitespace-only value', () => {
    hostTestState.modelByProvider = { copilot: '   ' };
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });

  it("treats 'auto' as no override (case-insensitive)", () => {
    hostTestState.modelByProvider = { copilot: 'Auto' };
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });

  it('returns the configured concrete model id, trimmed', () => {
    hostTestState.modelByProvider = { copilot: '  claude-sonnet-46  ' };
    expect(resolveReviewerModelOverride('copilot')).toBe('claude-sonnet-46');
  });

  it('does not fall back to a primary model for a provider without an entry', () => {
    hostTestState.modelByProvider = { copilot: 'gpt-5.5' };
    // gemini has no entry — must stay on its own CLI routing, not a primary.
    expect(resolveReviewerModelOverride('gemini')).toBeUndefined();
  });

  it('tolerates a missing override map entirely', () => {
    // Simulate an older persisted settings object with no map at all.
    hostTestState.modelByProvider = undefined as unknown as Record<string, string>;
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });
});
