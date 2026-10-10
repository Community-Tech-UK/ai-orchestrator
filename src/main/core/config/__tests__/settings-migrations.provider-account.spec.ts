import { describe, expect, it } from 'vitest';
import type { SettingsMigrationStore } from '../settings-migrations';
import {
  OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY,
  PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY,
  migrateOpenCodeLegacyProfile,
  migrateProviderAccountLegacyProfiles,
} from '../settings-migrations-provider-accounts';
import { ProviderAccountProfilesSchema } from '@contracts/schemas/provider-account';

function createStore(initial: Record<string, unknown> = {}): SettingsMigrationStore & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    get: (key) => values[key],
    persistSetting: (key, value) => { values[key] = value; },
    persistRawSetting: (key, value) => { values[key] = value; },
  };
}

describe('migrateProviderAccountLegacyProfiles', () => {
  it('creates schema-valid legacy Claude and Codex profiles once', () => {
    const store = createStore();
    expect(migrateProviderAccountLegacyProfiles(store, 42)).toBe(true);
    const profiles = store.values['providerAccountProfiles'] as Array<Record<string, unknown>>;
    expect(profiles).toEqual([
      expect.objectContaining({ id: 'legacy', provider: 'claude', isLegacy: true, priority: 0, enabled: true, label: 'Existing Claude account', automationPolicy: 'allow-routed', expectedIdentity: null }),
      expect.objectContaining({ id: 'legacy', provider: 'codex', isLegacy: true, priority: 0, enabled: true, label: 'Existing Codex account' }),
    ]);
    expect(ProviderAccountProfilesSchema.safeParse(profiles).success).toBe(true);
    expect(store.values[PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY]).toBe(true);
  });

  it('is idempotent once the marker is set', () => {
    const store = createStore();
    migrateProviderAccountLegacyProfiles(store, 42);
    store.values['providerAccountProfiles'] = [];
    expect(migrateProviderAccountLegacyProfiles(store, 43)).toBe(false);
    expect(store.values['providerAccountProfiles']).toEqual([]);
  });

  it('keeps existing profiles and avoids a priority collision', () => {
    const existing = {
      id: 'max-a-1a2b', provider: 'claude', label: 'Max A', expectedIdentity: null, expectedAccountKey: null,
      planLabel: null, priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: false, createdAt: 1, updatedAt: 1,
    };
    const store = createStore({ providerAccountProfiles: [existing] });
    migrateProviderAccountLegacyProfiles(store, 42);
    const profiles = store.values['providerAccountProfiles'] as Array<{ id: string; provider: string; priority: number }>;
    expect(profiles.find((profile) => profile.provider === 'claude' && profile.id === 'legacy')?.priority).toBe(1);
    expect(ProviderAccountProfilesSchema.safeParse(profiles).success).toBe(true);
  });

  it('never creates an OpenCode profile (that migration is conditional)', () => {
    const store = createStore();
    migrateProviderAccountLegacyProfiles(store, 42);
    const profiles = store.values['providerAccountProfiles'] as Array<{ provider: string }>;
    expect(profiles.some((profile) => profile.provider === 'opencode')).toBe(false);
  });
});

describe('migrateOpenCodeLegacyProfile', () => {
  const withNames = (names: string[], now = 42) => ({ readCredentialNames: () => names, now: () => now });

  it('creates the legacy MiMo profile for a xiaomi-token-plan credential, once', () => {
    const store = createStore();
    expect(migrateOpenCodeLegacyProfile(store, withNames(['xiaomi-token-plan-ams', 'other']))).toBe(true);
    const profiles = store.values['providerAccountProfiles'] as Array<Record<string, unknown>>;
    expect(profiles).toEqual([
      expect.objectContaining({
        id: 'legacy', provider: 'opencode', isLegacy: true, region: 'ams',
        enabled: true, automationPolicy: 'allow-routed', label: 'Existing MiMo account (ams)',
      }),
    ]);
    expect(ProviderAccountProfilesSchema.safeParse(profiles).success).toBe(true);
    expect(store.values[OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY]).toBe(true);
    store.values['providerAccountProfiles'] = [];
    expect(migrateOpenCodeLegacyProfile(store, withNames(['xiaomi-token-plan-ams']),)).toBe(false);
    expect(store.values['providerAccountProfiles']).toEqual([]);
  });

  it('creates no profile and keeps trying when no MiMo credential exists yet', () => {
    const store = createStore();
    expect(migrateOpenCodeLegacyProfile(store, withNames(['mimo-c']))).toBe(false);
    expect(store.values['providerAccountProfiles']).toBeUndefined();
    expect(store.values[OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY]).toBeUndefined();
    // Later sign-in: the next run creates it.
    expect(migrateOpenCodeLegacyProfile(store, withNames(['xiaomi-token-plan-sgp'], 43))).toBe(true);
    const profiles = store.values['providerAccountProfiles'] as Array<Record<string, unknown>>;
    expect(profiles[0]).toEqual(expect.objectContaining({ id: 'legacy', region: 'sgp' }));
    expect(ProviderAccountProfilesSchema.safeParse(profiles).success).toBe(true);
  });

  it('marks done without creating anything when a restored settings file already has a MiMo legacy profile', () => {
    const existing = {
      id: 'max-b-1a2b', provider: 'opencode', label: 'MiMo B', expectedIdentity: null, expectedAccountKey: null,
      planLabel: null, priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: false,
      region: 'ams', createdAt: 1, updatedAt: 1,
    };
    const store = createStore({ providerAccountProfiles: [existing] });
    // A pre-existing legacy opencode profile pins the migration.
    const withLegacy = createStore({
      providerAccountProfiles: [{ ...existing, id: 'legacy', isLegacy: true }],
    });
    expect(migrateOpenCodeLegacyProfile(withLegacy, withNames([]))).toBe(false);
    expect(withLegacy.values[OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY]).toBe(true);
    // A non-legacy profile alone does not: the legacy one is still created later.
    expect(migrateOpenCodeLegacyProfile(store, withNames(['xiaomi-token-plan-cn']))).toBe(true);
    const profiles = store.values['providerAccountProfiles'] as Array<{ id: string; priority: number }>;
    expect(profiles).toHaveLength(2);
    expect(profiles.find((profile) => profile.id === 'legacy')?.priority).toBe(1);
    expect(ProviderAccountProfilesSchema.safeParse(profiles).success).toBe(true);
  });

  it('survives a throwing credential reader', () => {
    const store = createStore();
    expect(migrateOpenCodeLegacyProfile(store, {
      readCredentialNames: () => { throw new Error('unreadable'); },
    })).toBe(false);
    expect(store.values['providerAccountProfiles']).toBeUndefined();
  });
});
