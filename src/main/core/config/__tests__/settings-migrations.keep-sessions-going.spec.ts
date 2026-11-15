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

function createStore(initial: Record<string, unknown> = {}): SettingsMigrationStore & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    get: (key: string) => values[key],
    persistSetting: (key: string, value: unknown) => { values[key] = value; },
    persistRawSetting: (key: string, value: unknown) => { values[key] = value; },
  };
}

/** `keepSessionsGoing` replaced the boolean `autoAnswerContinueQuestions` on 2026-11-15. */
describe('settings migration — keep sessions going', () => {
  beforeEach(() => { home.current = mkdtempSync(join(tmpdir(), 'keep-going-migration-')); });
  afterEach(() => { rmSync(home.current, { recursive: true, force: true }); });

  it('keeps the watcher off for someone who had switched the old setting off', () => {
    const store = createStore({ autoAnswerContinueQuestions: false });
    runSettingsMigrations(store);
    expect(store.values['keepSessionsGoing']).toBe('off');
  });

  it.each([
    ['on', { autoAnswerContinueQuestions: true }],
    ['never set', {}],
    ['not a boolean', { autoAnswerContinueQuestions: 'sometimes' }],
  ])('leaves the default alone when the old setting was %s', (_name, initial) => {
    const store = createStore(initial);
    runSettingsMigrations(store);
    expect('keepSessionsGoing' in store.values).toBe(false);
  });

  it('runs once, so a later choice is not undone', () => {
    const store = createStore({ autoAnswerContinueQuestions: false });
    runSettingsMigrations(store);
    store.values['keepSessionsGoing'] = 'own-suggestions';
    runSettingsMigrations(store);
    expect(store.values['keepSessionsGoing']).toBe('own-suggestions');
  });
});
