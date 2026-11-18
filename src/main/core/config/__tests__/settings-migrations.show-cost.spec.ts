import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = { current: '' };

vi.mock('electron', () => ({
  app: { getPath: () => home.current },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../cli/adapters/adapter-spawn-helpers', () => ({
  getCopilotOrchestratorHome: () => join(home.current, 'copilot-cli-home'),
}));

import { runSettingsMigrations, type SettingsMigrationStore } from '../settings-migrations';

const MARKER = '__migration_show_cost_enabled_20261020';

function createStore(initial: Record<string, unknown> = {}): SettingsMigrationStore & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    get: (key: string) => values[key],
    persistSetting: (key: string, value: unknown) => { values[key] = value; },
    persistRawSetting: (key: string, value: unknown) => { values[key] = value; },
  };
}

/** Decision 15(a), LT-1156: the cost display is switched on once; later opt-outs survive. */
describe('settings migration — show cost estimates', () => {
  beforeEach(() => { home.current = mkdtempSync(join(tmpdir(), 'show-cost-migration-')); });
  afterEach(() => { rmSync(home.current, { recursive: true, force: true }); });

  it('turns a stored "off" on once and records the marker', () => {
    const store = createStore({ showCost: false });
    runSettingsMigrations(store);
    expect(store.values['showCost']).toBe(true);
    expect(store.values[MARKER]).toBe(true);
  });

  it('keeps a later explicit opt-out after the marker is set', () => {
    const store = createStore({ showCost: false });
    runSettingsMigrations(store);
    store.values['showCost'] = false;
    runSettingsMigrations(store);
    expect(store.values['showCost']).toBe(false);
  });

  it('writes no showCost value when none was saved', () => {
    const store = createStore();
    runSettingsMigrations(store);
    expect('showCost' in store.values).toBe(false);
    expect(store.values[MARKER]).toBe(true);
  });
});
