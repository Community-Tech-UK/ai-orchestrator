/**
 * Legacy account-profile migration for provider account pools.
 *
 * Creates one `legacy` profile per pooled provider, bound to the pre-existing
 * `~/.claude` and `~/.codex` sign-ins. Nothing is read, copied or moved: with
 * only the legacy profile a spawn sets no `CLAUDE_CONFIG_DIR` and links the
 * shared `~/.codex/auth.json`, so an existing install behaves exactly as it did
 * before pools. Identity is left null and verified lazily by the binding
 * service (no credential or config file reads here).
 *
 * Split out of settings-migrations.ts to keep that file within its size ceiling.
 */

import type { SettingsMigrationStore } from './settings-migrations';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  POOLED_PROVIDERS,
  pooledProviderLabel,
  type ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';

export const PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY =
  '__migration_provider_account_legacy_profiles_20260913';

export function migrateProviderAccountLegacyProfiles(
  store: SettingsMigrationStore,
  now: number = Date.now(),
): boolean {
  if (store.get(PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY)) {
    return false;
  }
  const existing = store.get('providerAccountProfiles');
  const profiles: ProviderAccountProfile[] = Array.isArray(existing)
    ? [...(existing as ProviderAccountProfile[])]
    : [];

  for (const provider of POOLED_PROVIDERS) {
    const own = profiles.filter((profile) => profile.provider === provider);
    if (own.some((profile) => profile.id === LEGACY_ACCOUNT_PROFILE_ID)) continue;
    // A restored settings file may already hold profiles; add the legacy one
    // after them rather than colliding with an existing priority.
    const priority = own.some((profile) => profile.priority === 0)
      ? own.reduce((max, profile) => Math.max(max, profile.priority), 0) + 1
      : 0;
    profiles.push({
      id: LEGACY_ACCOUNT_PROFILE_ID,
      provider,
      label: `Existing ${pooledProviderLabel(provider)} account`,
      expectedIdentity: null,
      expectedAccountKey: null,
      planLabel: null,
      priority,
      enabled: true,
      automationPolicy: 'allow-routed',
      isLegacy: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  store.persistSetting('providerAccountProfiles', profiles);
  store.persistRawSetting(PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY, true);
  return true;
}
