import { describe, expect, it } from 'vitest';
import type { SettingsMigrationStore } from '../settings-migrations';
import {
  PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY,
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
});
