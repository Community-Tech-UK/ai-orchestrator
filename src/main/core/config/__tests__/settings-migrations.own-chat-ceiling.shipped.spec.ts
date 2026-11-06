import { join } from 'path';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated from the machine: no real settings, Copilot home, account files or logger output are touched.
vi.mock('electron', () => ({ app: { getPath: () => join(tmpdir(), 'aio-own-chat-ceiling-no-user-data') } }));
vi.mock('../../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../cli/adapters/adapter-spawn-helpers', () => ({ getCopilotOrchestratorHome: () => join(tmpdir(), 'aio-own-chat-ceiling-no-copilot-home') }));
vi.mock('../settings-migrations-provider-accounts', () => ({ migrateProviderAccountLegacyProfiles: () => false, migrateOpenCodeLegacyProfile: () => false }));
// Wrap, not replace: the real gate runs, and the spy shows the settings seam really calls it.
vi.mock('../settings-migrations-own-chat-ceiling', async importOriginal => {
  const actual = await importOriginal<typeof import('../settings-migrations-own-chat-ceiling')>();
  return { ...actual, migrateOwnChatContextCeiling: vi.fn(actual.migrateOwnChatContextCeiling) };
});

import { DEFAULT_SETTINGS } from '../../../../shared/types/settings-defaults';
import { OWN_CHAT_CEILING_RECALL_EVIDENCE } from '../own-chat-ceiling-recall-evidence';
import { runSettingsMigrations, type SettingsMigrationStore } from '../settings-migrations';
import { OWN_CHAT_CEILING_MIGRATION_KEY, migrateOwnChatContextCeiling } from '../settings-migrations-own-chat-ceiling';

const OUR_KEYS = ['ownChatContextCeilingTokens', 'machineContextCeilingTokens', OWN_CHAT_CEILING_MIGRATION_KEY];

function createStore(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  const writes: string[] = [];
  const store: SettingsMigrationStore = {
    get: key => values[key],
    persistSetting: (key, value) => { values[key] = value; writes.push(key); },
    persistRawSetting: (key, value) => { values[key] = value; writes.push(key); },
  };
  return { store, values, writes };
}

describe('own-chat context ceiling as shipped: no passing recall check, so a strict no-op', () => {
  beforeEach(() => { vi.mocked(migrateOwnChatContextCeiling).mockClear(); });

  it('ships with no recall evidence and the ceiling off by default for chats and for helpers', () => {
    // Release condition: the recorded long-chat recall check failed the rule, so no passing evidence exists.
    expect(OWN_CHAT_CEILING_RECALL_EVIDENCE).toBeNull();
    expect(DEFAULT_SETTINGS.ownChatContextCeilingTokens).toBe(0);
    expect(DEFAULT_SETTINGS.machineContextCeilingTokens).toBe(0);
  });

  it('is called once by runSettingsMigrations and answers "no evidence" without writing', () => {
    const { store } = createStore({ ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 0 });
    runSettingsMigrations(store);
    expect(migrateOwnChatContextCeiling).toHaveBeenCalledTimes(1);
    expect(migrateOwnChatContextCeiling).toHaveBeenCalledWith(store);
    expect(vi.mocked(migrateOwnChatContextCeiling).mock.results[0].value).toEqual({ result: 'not-eligible', reason: 'no-evidence' });
  });

  const states: Array<[string, Record<string, unknown>]> = [
    ['the untouched default', { ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 0 }],
    ['nothing stored yet', {}],
    ['a cap the user chose for chats', { ownChatContextCeilingTokens: 450_000, machineContextCeilingTokens: 0 }],
    ['a cap for chats and one for helpers', { ownChatContextCeilingTokens: 450_000, machineContextCeilingTokens: 200_000 }],
    ['only a helper cap', { ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 200_000 }],
  ];
  for (const [name, initial] of states) {
    it(`changes none of its three settings and writes no marker: ${name}`, () => {
      const { store, values, writes } = createStore(initial);
      runSettingsMigrations(store);
      runSettingsMigrations(store);
      runSettingsMigrations(store);
      expect(writes.filter(key => OUR_KEYS.includes(key))).toEqual([]);
      expect(OUR_KEYS.map(key => values[key])).toEqual([initial['ownChatContextCeilingTokens'], initial['machineContextCeilingTokens'], undefined]);
    });
  }

  it('does not stop the other migrations: they still run and leave their own markers', () => {
    const { store, values } = createStore();
    runSettingsMigrations(store);
    expect(values['__migration_copilot_legacy_profile_20260825']).toBe(true);
    expect(values['__migration_reviewer_model_defaults_20260712']).toBe(true);
    expect(migrateOwnChatContextCeiling).toHaveBeenCalledTimes(1);
  });
});
