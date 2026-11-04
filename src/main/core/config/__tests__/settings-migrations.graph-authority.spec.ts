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
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';

const LEGACY_AUTHORITY = 'https://login.microsoftonline.com/60b0a25e-b75d-4d9e-b797-1805ec311dfb';
const MARKER = '__migration_graph_authority_organizations_20261103';

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

/** Microsoft sign-in moved from the Community Tech directory to any organisation. */
describe('settings migration — Microsoft sign-in authority', () => {
  beforeEach(() => { home.current = mkdtempSync(join(tmpdir(), 'graph-authority-migration-')); });
  afterEach(() => { rmSync(home.current, { recursive: true, force: true }); });

  it('replaces the saved old Community Tech default with the current default', () => {
    const store = createStore({ graphAuthority: LEGACY_AUTHORITY });
    runSettingsMigrations(store);
    expect(store.values['graphAuthority']).toBe(DEFAULT_SETTINGS.graphAuthority);
    expect(store.values['graphAuthority']).toBe('https://login.microsoftonline.com/organizations');
    expect(store.values[MARKER]).toBe(true);
  });

  it('keeps any other saved authority', () => {
    const custom = 'https://login.microsoftonline.com/contoso.onmicrosoft.com';
    const store = createStore({ graphAuthority: custom });
    runSettingsMigrations(store);
    expect(store.values['graphAuthority']).toBe(custom);
    expect(store.writes).not.toContain('graphAuthority');
  });

  it('runs once, so a later deliberate return to the old directory stays', () => {
    const store = createStore({ graphAuthority: LEGACY_AUTHORITY, [MARKER]: true });
    runSettingsMigrations(store);
    expect(store.values['graphAuthority']).toBe(LEGACY_AUTHORITY);
    expect(store.writes).not.toContain('graphAuthority');
  });
});
