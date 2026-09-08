import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ai-orchestrator-settings-migration-test' },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../cli/adapters/adapter-spawn-helpers', () => ({
  getCopilotOrchestratorHome: () => '/tmp/ai-orchestrator-settings-migration-test/copilot',
}));

import { runSettingsMigrations, type SettingsMigrationStore } from '../settings-migrations';

function createStore(initial: Record<string, unknown>): SettingsMigrationStore & {
  values: Record<string, unknown>;
} {
  const values = { ...initial };
  return {
    values,
    get: (key) => values[key],
    persistSetting: (key, value) => {
      values[key] = value;
    },
    persistRawSetting: (key, value) => {
      values[key] = value;
    },
  };
}

function titleFallbackEnabled(store: { values: Record<string, unknown> }): boolean | undefined {
  const slots = JSON.parse(store.values['auxiliaryLlmSlotsJson'] as string) as {
    titleGeneration?: { allowFrontierFallback?: boolean };
  };
  return slots.titleGeneration?.allowFrontierFallback;
}

function titleBudget(store: { values: Record<string, unknown> }): number | undefined {
  const slots = JSON.parse(store.values['auxiliaryLlmSlotsJson'] as string) as {
    titleGeneration?: { maxOutputTokens?: number };
  };
  return slots.titleGeneration?.maxOutputTokens;
}

describe('auxiliary title fallback migration', () => {
  it('re-enables a persisted disabled title fallback once, then preserves a later user opt-out', () => {
    const store = createStore({
      auxiliaryLlmSlotsJson: JSON.stringify({
        titleGeneration: {
          enabled: true,
          provider: 'auto',
          maxInputTokens: 12_000,
          maxOutputTokens: 512,
          temperature: 0.2,
          timeoutMs: 45_000,
          requireJson: false,
          allowFrontierFallback: false,
        },
      }),
      copilotAccountProfiles: [],
      __migration_copilot_legacy_profile_20260825: true,
    });

    runSettingsMigrations(store);
    expect(titleFallbackEnabled(store)).toBe(true);

    const slots = JSON.parse(store.values['auxiliaryLlmSlotsJson'] as string) as Record<
      string,
      Record<string, unknown>
    >;
    slots['titleGeneration']!['allowFrontierFallback'] = false;
    store.values['auxiliaryLlmSlotsJson'] = JSON.stringify(slots);

    runSettingsMigrations(store);
    expect(titleFallbackEnabled(store)).toBe(false);
  });

  it('raises a 512-token title budget to fit a reasoning model, once', () => {
    const store = createStore({
      auxiliaryLlmSlotsJson: JSON.stringify({
        titleGeneration: {
          enabled: true,
          provider: 'auto',
          maxInputTokens: 12_000,
          maxOutputTokens: 512,
          temperature: 0.2,
          timeoutMs: 45_000,
          requireJson: false,
          allowFrontierFallback: true,
        },
      }),
      copilotAccountProfiles: [],
      __migration_copilot_legacy_profile_20260825: true,
    });

    runSettingsMigrations(store);
    expect(titleBudget(store)).toBe(1536);

    // A later deliberate reduction is the user's call and must survive.
    const slots = JSON.parse(store.values['auxiliaryLlmSlotsJson'] as string) as Record<
      string,
      Record<string, unknown>
    >;
    slots['titleGeneration']!['maxOutputTokens'] = 256;
    store.values['auxiliaryLlmSlotsJson'] = JSON.stringify(slots);

    runSettingsMigrations(store);
    expect(titleBudget(store)).toBe(256);
  });
});
