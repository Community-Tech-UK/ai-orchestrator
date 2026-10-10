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

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SettingsMigrationStore } from './settings-migrations';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  OPENCODE_ACCOUNT_REGIONS,
  type ProviderAccountProfile,
  pooledProviderLabel,
} from '../../../shared/types/provider-account.types';

export const PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY =
  '__migration_provider_account_legacy_profiles_20260913';

export const OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY =
  '__migration_provider_account_opencode_legacy_20261010';

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

  // Deliberately NOT POOLED_PROVIDERS: the OpenCode/MiMo legacy profile is
  // conditional on an existing `xiaomi-token-plan-*` credential and is created
  // by migrateOpenCodeLegacyProfile() below.
  for (const provider of ['claude', 'codex'] as const) {
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

export interface OpenCodeLegacyMigrationDeps {
  /**
   * OpenCode credential names exactly as `opencode auth list` reports them
   * (names only; values are never read). Injectable for tests.
   */
  readCredentialNames?: () => string[];
  now?: () => number;
}

/**
 * Where OpenCode keeps its key store (`auth.json`), on every platform: the XDG
 * data home, `~/.local/share/opencode` by default. Only the file's top-level
 * key NAMES are read (bounded); key values are never retained or logged.
 */
export function readOpenCodeAuthCredentialNames(): string[] {
  try {
    const dataHome = process.env['XDG_DATA_HOME']?.trim() || path.join(os.homedir(), '.local', 'share');
    const authPath = path.join(dataHome, 'opencode', 'auth.json');
    const stats = fs.statSync(authPath);
    if (stats.size > 256 * 1024) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    return Object.keys(parsed).filter((name) => /^xiaomi-token-plan-(ams|sgp|cn)$/.test(name));
  } catch {
    return [];
  }
}

/**
 * Legacy OpenCode/MiMo account profile: bound to the pre-existing
 * `xiaomi-token-plan-<region>` credential in OpenCode's own key store (nothing
 * is read, copied or moved; names only). Created only when such a credential
 * exists, so a fresh or non-MiMo install gets no OpenCode profile. Until one is
 * created (or found pre-existing in a restored settings file) this re-checks on
 * every startup; afterwards the marker pins it (once-only, idempotent).
 */
export function migrateOpenCodeLegacyProfile(
  store: SettingsMigrationStore,
  deps: OpenCodeLegacyMigrationDeps = {},
): boolean {
  if (store.get(OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY)) {
    return false;
  }
  const now = deps.now?.() ?? Date.now();
  const existing = store.get('providerAccountProfiles');
  const profiles: ProviderAccountProfile[] = Array.isArray(existing)
    ? [...(existing as ProviderAccountProfile[])]
    : [];
  const alreadyThere = profiles.some(
    (profile) => profile.provider === 'opencode' && profile.id === LEGACY_ACCOUNT_PROFILE_ID,
  );
  if (alreadyThere) {
    store.persistRawSetting(OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY, true);
    return false;
  }

  let names: string[] = [];
  try {
    names = (deps.readCredentialNames ?? readOpenCodeAuthCredentialNames)();
  } catch {
    names = [];
  }
  const region = OPENCODE_ACCOUNT_REGIONS.find((candidate) =>
    names.includes(`xiaomi-token-plan-${candidate}`),
  );
  if (!region) {
    // No existing MiMo sign-in to bind: try again on the next start.
    return false;
  }

  const own = profiles.filter((profile) => profile.provider === 'opencode');
  const priority = own.some((profile) => profile.priority === 0)
    ? own.reduce((max, profile) => Math.max(max, profile.priority), 0) + 1
    : 0;
  profiles.push({
    id: LEGACY_ACCOUNT_PROFILE_ID,
    provider: 'opencode',
    label: `Existing MiMo account (${region})`,
    expectedIdentity: null,
    expectedAccountKey: null,
    planLabel: null,
    priority,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: true,
    region,
    createdAt: now,
    updatedAt: now,
  });
  store.persistSetting('providerAccountProfiles', profiles);
  store.persistRawSetting(OPENCODE_ACCOUNT_LEGACY_MIGRATION_KEY, true);
  return true;
}
