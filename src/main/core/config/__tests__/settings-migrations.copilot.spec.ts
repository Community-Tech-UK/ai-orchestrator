import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copilotHome = { current: '' };

vi.mock('electron', () => ({
  app: { getPath: () => copilotHome.current },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../cli/adapters/adapter-spawn-helpers', () => ({
  getCopilotOrchestratorHome: () => join(copilotHome.current, 'copilot-cli-home'),
}));

import { runSettingsMigrations, type SettingsMigrationStore } from '../settings-migrations';

/**
 * The migration that makes an existing single-account install work with account
 * routing. The bar it has to clear: a one-account install must behave EXACTLY
 * as before — same Copilot home, no files moved, no invented routing rules.
 */
interface Profile {
  id: string;
  label: string;
  expectedLogin: string | null;
  host: string;
  isDefault: boolean;
  isLegacy?: boolean;
  scopePolicy: string;
  automationPolicy: string;
}

function createStore(initial: Record<string, unknown> = {}): SettingsMigrationStore & {
  values: Record<string, unknown>;
  writes: string[];
} {
  const values: Record<string, unknown> = { ...initial };
  const writes: string[] = [];
  return {
    values,
    writes,
    get: (key: string) => values[key],
    persistSetting: (key: string, value: unknown) => {
      values[key] = value;
      writes.push(key);
    },
    persistRawSetting: (key: string, value: unknown) => {
      values[key] = value;
      writes.push(key);
    },
  };
}

function profilesOf(store: { values: Record<string, unknown> }): Profile[] {
  return (store.values['copilotAccountProfiles'] as Profile[] | undefined) ?? [];
}

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copilot-migration-'));
  copilotHome.current = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeCopilotConfig(contents: string): void {
  const home = join(root, 'copilot-cli-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), contents, 'utf8');
}

describe('legacy Copilot profile migration', () => {
  it('creates a default, default-eligible legacy profile', () => {
    const store = createStore();
    runSettingsMigrations(store);

    const profiles = profilesOf(store);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: 'legacy',
      label: 'Existing Copilot account',
      isDefault: true,
      isLegacy: true,
      // Preserves current behaviour: this account services every workspace.
      scopePolicy: 'default-eligible',
      automationPolicy: 'allow-routed',
    });
  });

  it('creates no routing rules — one account has nothing to route between', () => {
    const store = createStore();
    runSettingsMigrations(store);
    expect(store.values['copilotAccountRoutingRules']).toBeUndefined();
  });

  it('adopts the identity already signed in, so no re-login is needed', () => {
    writeCopilotConfig(
      JSON.stringify({ lastLoggedInUser: { host: 'GitHub.com', login: 'octocat' } }),
    );
    const store = createStore();
    runSettingsMigrations(store);
    expect(profilesOf(store)[0]).toMatchObject({ expectedLogin: 'octocat', host: 'github.com' });
  });

  it('falls back to loggedInUsers when lastLoggedInUser is absent', () => {
    writeCopilotConfig(
      JSON.stringify({ loggedInUsers: [{ host: 'github.com', login: 'octocat' }] }),
    );
    const store = createStore();
    runSettingsMigrations(store);
    expect(profilesOf(store)[0].expectedLogin).toBe('octocat');
  });

  it('creates the profile unauthenticated when there is no config to read', () => {
    const store = createStore();
    runSettingsMigrations(store);
    expect(profilesOf(store)[0].expectedLogin).toBeNull();
  });

  it('never carries a plaintext token out of the existing config', () => {
    const secretShaped = 'gho_NOT_A_REAL_TOKEN_placeholder';
    writeCopilotConfig(
      JSON.stringify({
        lastLoggedInUser: { host: 'github.com', login: 'octocat' },
        copilotTokens: { 'github.com:octocat': secretShaped },
      }),
    );
    const store = createStore();
    runSettingsMigrations(store);
    expect(JSON.stringify(store.values)).not.toContain(secretShaped);
    expect(JSON.stringify(store.values)).not.toContain('copilotTokens');
  });

  it('tolerates a malformed config and still creates the profile', () => {
    writeCopilotConfig('{ not json at all');
    const store = createStore();
    runSettingsMigrations(store);
    expect(profilesOf(store)).toHaveLength(1);
    expect(profilesOf(store)[0].expectedLogin).toBeNull();
  });

  it('is idempotent across two runs', () => {
    const store = createStore();
    runSettingsMigrations(store);
    const afterFirst = JSON.stringify(store.values['copilotAccountProfiles']);
    runSettingsMigrations(store);
    expect(JSON.stringify(store.values['copilotAccountProfiles'])).toBe(afterFirst);
    expect(profilesOf(store)).toHaveLength(1);
  });

  it('does not re-add a profile the user deliberately removed', () => {
    // Marker already set from a previous run, profiles cleared by the user.
    const store = createStore({
      '__migration_copilot_legacy_profile_20260825': true,
      copilotAccountProfiles: [],
    });
    runSettingsMigrations(store);
    expect(profilesOf(store)).toHaveLength(0);
  });

  it('leaves an already-configured multi-account setup untouched', () => {
    const existing = [
      {
        id: 'enterprise',
        label: 'Enterprise',
        expectedLogin: 'acme-bot',
        host: 'github.com',
        isDefault: true,
        scopePolicy: 'default-eligible',
        automationPolicy: 'allow-routed',
      },
    ];
    const store = createStore({ copilotAccountProfiles: existing });
    runSettingsMigrations(store);
    expect(profilesOf(store)).toEqual(existing);
  });
});
