import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';

// ElectronStore mock — in-memory key/value
const store: Record<string, unknown> = {};
const mockStoreSet = vi.fn((k: string | Record<string, unknown>, v?: unknown) => {
  if (typeof k === 'object') Object.assign(store, k);
  else store[k] = v;
});
vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      get store() { return { ...store }; },
      get: vi.fn((k: string) => store[k]),
      set: mockStoreSet,
      clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
      path: '/tmp/test-settings.json',
    })),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => `/tmp/test-${key}`),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

import { SettingsManager } from '../settings-manager';

beforeEach(() => {
  // Clear store between tests
  for (const k of Object.keys(store)) delete store[k];
  mockStoreSet.mockClear();
});

describe('SettingsManager settings cache', () => {
  it('getMerged() returns a settings object', () => {
    const mgr = new SettingsManager();
    const merged = mgr.getMerged();
    expect(merged).toBeDefined();
    expect(typeof merged).toBe('object');
  });

  it('getMerged() returns the same reference on repeated calls (cached)', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    const second = mgr.getMerged();
    // Same object reference — cache is alive
    expect(first).toBe(second);
  });

  it('invalidate(3) clears the merged cache', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    mgr.invalidate(3);
    const second = mgr.getMerged();
    // New object after invalidation
    expect(first).not.toBe(second);
  });

  it('invalidate(1) cascades to levels 2 and 3', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    mgr.invalidate(1);
    const second = mgr.getMerged();
    expect(first).not.toBe(second);
  });

  it('invalidate() with no argument clears all levels', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    mgr.invalidate();
    const second = mgr.getMerged();
    expect(first).not.toBe(second);
  });

  it('getMerged() reflects a setting change after invalidation', () => {
    const mgr = new SettingsManager();
    mgr.set('theme', 'dark');
    mgr.invalidate(3);
    const merged = mgr.getMerged();
    expect(merged.theme).toBe('dark');
  });

  it('migrates persisted GPT-5.4 defaults to GPT-5.5', () => {
    store['defaultModel'] = 'gpt-5.4-mini';
    const mgr = new SettingsManager();

    expect(mgr.get('defaultModel')).toBe('gpt-5.5-mini');
  });

  it('migrates previously-persisted legacy codebase auto-index opt-in back to disabled', () => {
    store['codebaseAutoIndexEnabled'] = true;

    const mgr = new SettingsManager();

    expect(mgr.get('codebaseAutoIndexEnabled')).toBe(false);
    expect(store['__migration_codebase_auto_index_disabled_20260527']).toBe(true);
  });

  it('does not override a later explicit legacy codebase auto-index opt-in after migration ran', () => {
    store['__migration_codebase_auto_index_disabled_20260527'] = true;
    store['codebaseAutoIndexEnabled'] = true;

    const mgr = new SettingsManager();

    expect(mgr.get('codebaseAutoIndexEnabled')).toBe(true);
  });

  it('migrates persisted resident Claude sessions to enabled', () => {
    store['residentClaudeSession'] = false;

    const mgr = new SettingsManager();

    expect(mgr.get('residentClaudeSession')).toBe(true);
  });

  it('merges missing auxiliary slots once during construction', () => {
    store['__migration_auxiliary_slot_timeouts_20260606'] = true;
    store['__migration_auxiliary_frontier_fallback_20260606'] = true;
    store['__migration_auxiliary_slot_tiers_20260609'] = true;
    store['__migration_auxiliary_title_budget_20260609'] = true;
    const defaults = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as Record<string, unknown>;
    const persisted = { ...defaults };
    delete persisted['retrievalHypothesis'];
    store['auxiliaryLlmSlotsJson'] = JSON.stringify(persisted);

    new SettingsManager();

    const persistedAfterFirst = JSON.parse(store['auxiliaryLlmSlotsJson'] as string) as Record<string, unknown>;
    expect(persistedAfterFirst['retrievalHypothesis']).toEqual(defaults['retrievalHypothesis']);
    expect(mockStoreSet).toHaveBeenCalledWith('auxiliaryLlmSlotsJson', expect.any(String));

    mockStoreSet.mockClear();
    new SettingsManager();

    expect(
      mockStoreSet.mock.calls.some(([key]) => key === 'auxiliaryLlmSlotsJson'),
    ).toBe(false);
  });
});
