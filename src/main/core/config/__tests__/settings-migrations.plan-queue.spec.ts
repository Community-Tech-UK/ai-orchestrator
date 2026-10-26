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

function createStore(initial: Record<string, unknown> = {}): SettingsMigrationStore & { values: Record<string, unknown>; writes: string[] } {
  const values: Record<string, unknown> = { ...initial };
  const writes: string[] = [];
  return {
    values,
    writes,
    get: (key: string) => values[key],
    persistSetting: (key: string, value: unknown) => { values[key] = value; writes.push(key); },
    persistRawSetting: (key: string, value: unknown) => { values[key] = value; writes.push(key); },
  };
}

/** Plan Queue workers became a ranked list on 2026-10-25. */
describe('settings migration — Plan Queue worker list', () => {
  beforeEach(() => { home.current = mkdtempSync(join(tmpdir(), 'pq-routing-migration-')); });
  afterEach(() => { rmSync(home.current, { recursive: true, force: true }); });

  it('moves a saved single worker choice into a one-choice list, keeping the checkers', () => {
    const store = createStore({
      planQueueRouting: { worker: { provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-2'] }, verifiers: [{ provider: 'claude' }] },
    });
    runSettingsMigrations(store);
    expect(store.values['planQueueRouting']).toEqual({
      workers: [{ provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-2'] }], verifiers: [{ provider: 'claude' }],
    });
  });

  it('moves a saved "same as the session" choice into an empty list', () => {
    const store = createStore({ planQueueRouting: { worker: null, verifiers: [] } });
    runSettingsMigrations(store);
    expect(store.values['planQueueRouting']).toEqual({ workers: [], verifiers: [] });
  });

  it('leaves an upgraded or missing value alone, so a second run writes nothing', () => {
    const upgraded = { workers: [{ provider: 'claude' }, { provider: 'codex' }], verifiers: [] };
    const store = createStore({ planQueueRouting: upgraded });
    runSettingsMigrations(store);
    expect(store.values['planQueueRouting']).toBe(upgraded);
    expect(store.writes).not.toContain('planQueueRouting');

    const empty = createStore();
    runSettingsMigrations(empty);
    expect(empty.writes).not.toContain('planQueueRouting');
  });
});
