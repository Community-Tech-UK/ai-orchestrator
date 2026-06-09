/**
 * Settings Manager - Manages application settings with persistence
 */

import ElectronStore from 'electron-store';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { AppSettings } from '../../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { backfillSlotTiers, raiseSlotOutputBudget } from '../../rlm/auxiliary-llm-utils';
import { getLogger } from '../../logging/logger';
import { PAUSE_SETTING_VALIDATORS, type Validator } from './settings-validators';

const logger = getLogger('SettingsManager');

/**
 * Ordered config source hierarchy — later sources take precedence.
 * Merge order: User (global) -> Project (repo-local) -> Local (gitignored) -> Env -> CLI args.
 * Motivated by claw-code ConfigSource enum (claude2.md section 9.1).
 */
export const CONFIG_SOURCE_PRECEDENCE = ['user', 'project', 'local', 'env', 'cli'] as const;
export type ConfigSourceLevel = typeof CONFIG_SOURCE_PRECEDENCE[number];

/**
 * Legacy app name for migration purposes
 */
const LEGACY_APP_NAME = 'claude-orchestrator';
const CODEBASE_AUTOINDEX_DISABLED_MIGRATION_KEY =
  '__migration_codebase_auto_index_disabled_20260527';
const AUX_SLOT_TIMEOUT_MIGRATION_KEY =
  '__migration_auxiliary_slot_timeouts_20260606';
const AUX_FRONTIER_FALLBACK_MIGRATION_KEY =
  '__migration_auxiliary_frontier_fallback_20260606';
const AUX_SLOT_TIERS_MIGRATION_KEY =
  '__migration_auxiliary_slot_tiers_20260609';
const AUX_TITLE_BUDGET_MIGRATION_KEY =
  '__migration_auxiliary_title_budget_20260609';

// Type for the internal store with the methods we need
interface Store<T> {
  store: T;
  path: string;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  set(object: Partial<T>): void;
  clear(): void;
}

interface MigrationStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * Three-level settings cache.
 *
 * Level 1: raw file parse results (reserved for future per-source parsing).
 * Level 2: per-source merged results (reserved for future multi-source merging).
 * Level 3: fully merged AppSettings — most expensive to recompute.
 *
 * Currently only level 3 is populated; levels 1 and 2 are placeholders
 * for future per-source caching.  Invalidation cascades downward:
 * clearing level 1 also clears 2 and 3; clearing level 2 also clears 3.
 */
interface SettingsCache {
  /** Level 3: Fully merged settings — most expensive to recompute */
  merged: AppSettings | null;
  /** Level 3 timestamp — when merged was last computed */
  mergedAt: number;
}

export class SettingsManager extends EventEmitter {
  private store: Store<AppSettings>;
  private settingsCache: SettingsCache = { merged: null, mergedAt: 0 };

  private validateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings[K] {
    const validator = PAUSE_SETTING_VALIDATORS[key] as Validator<K> | undefined;
    if (!validator) return value;

    const result = validator(value);
    if (!result.ok) {
      throw new Error(`Invalid setting ${String(key)}: ${result.error}`);
    }

    return result.value;
  }

  private normalizeSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings[K] {
    if (key === 'defaultCli' && value === 'openai') {
      return 'codex' as AppSettings[K];
    }
    return value;
  }

  constructor() {
    super();

    // Attempt migration from legacy app data before initializing store
    this.migrateFromLegacyApp();

    // Cast to our Store interface to work around ESM type resolution issues
    this.store = new ElectronStore<AppSettings>({
      name: 'settings',
      defaults: DEFAULT_SETTINGS,
    }) as unknown as Store<AppSettings>;

    // Migrate stale model names to bare shorthand names
    this.migrateModelNames();
    // Migrate legacy CLI alias to canonical provider key
    this.migrateCliProviderAlias();
    // Existing installs may have persisted the old, heavy auto-index default.
    this.migrateLegacyCodebaseAutoIndexDefault();
    // Existing installs may have persisted the old 15s auxiliary slot timeouts,
    // which are too short for a cold local-model load.
    this.migrateAuxiliarySlotTimeouts();
    // allowFrontierFallback is now enforced. Existing installs persisted it as
    // `false` while it was inert; flip the two text slots back to the new `true`
    // default so they don't silently lose primary-LLM quality on upgrade.
    this.migrateAuxiliaryFrontierFallbackDefault();
    // Existing installs persisted slot configs before the quick/quality tier
    // feature; backfill each slot's `tier` so the model-tier selection and UI
    // reflect sensible defaults instead of "none".
    this.migrateAuxiliarySlotTiers();
    // titleGeneration shipped with a 128-token budget — too small for reasoning
    // local models, which spend it all thinking and emit an empty title. Raise
    // existing installs to 512 so titles actually generate.
    this.migrateTitleGenerationBudget();
    // Seed per-provider model memory from existing defaultModel/defaultCli on
    // first launch after this feature lands. This avoids an empty map showing
    // 'opus' for Claude and nothing else.
    this.seedDefaultModelByProvider();
  }

  /**
   * Migrate old full model IDs (e.g. 'claude-opus-4-5') to bare shorthand names ('opus').
   * electron-store persists values, so changing DEFAULT_SETTINGS alone won't update
   * already-persisted values.
   */
  private migrateModelNames(): void {
    const MODEL_MIGRATION: Record<string, string> = {
      'claude-opus-4-5': 'opus',
      'claude-opus-4-5-20250918': 'opus',
      'claude-sonnet-4-5': 'sonnet',
      'claude-sonnet-4-5-20250929': 'sonnet',
      'claude-haiku-4-5': 'haiku',
      'claude-haiku-4-5-20251001': 'haiku',
      'claude-opus-4-6': 'opus',
      'claude-opus-4-6-20260401': 'opus',
      'claude-sonnet-4-6': 'sonnet',
      'claude-sonnet-4-6-20260401': 'sonnet',
      'claude-haiku-4-6': 'haiku',
      'claude-haiku-4-6-20260401': 'haiku',
      // Older generation
      'claude-sonnet-4-20250514': 'sonnet',
      'claude-opus-4-20250514': 'opus',
      'claude-3-5-sonnet-20241022': 'sonnet',
      'claude-3-5-haiku-20241022': 'haiku',
      // Previous OpenAI/Codex defaults
      'gpt-5.4': 'gpt-5.5',
      'gpt-5.4-mini': 'gpt-5.5-mini',
      // Legacy Codex alias
      'codex-mini-latest': 'gpt-5.3-codex',
    };

    const currentModel = this.store.get('defaultModel');
    if (currentModel && MODEL_MIGRATION[currentModel]) {
      const newModel = MODEL_MIGRATION[currentModel];
      logger.info('Migrating defaultModel', { currentModel, newModel });
      this.store.set('defaultModel', newModel);
    }
  }

  /**
   * Migrate legacy defaultCli alias ("openai") to canonical runtime provider ("codex").
   */
  private migrateCliProviderAlias(): void {
    const currentCli = this.store.get('defaultCli');
    if (currentCli === 'openai') {
      this.store.set('defaultCli', 'codex');
    }
  }

  /**
   * Disable the legacy RLM codebase auto-indexer once for existing installs.
   *
   * Changing DEFAULT_SETTINGS protects new installs, but electron-store keeps
   * older persisted values. This one-shot migration clears the old heavy
   * default while still allowing the user to explicitly re-enable the legacy path
   * later for diagnostics.
   */
  private migrateLegacyCodebaseAutoIndexDefault(): void {
    const migrationStore = this.store as unknown as MigrationStore;
    if (migrationStore.get(CODEBASE_AUTOINDEX_DISABLED_MIGRATION_KEY) === true) {
      return;
    }

    if (this.store.get('codebaseAutoIndexEnabled') === true) {
      logger.info('Disabling persisted legacy codebase auto-index default');
      this.store.set('codebaseAutoIndexEnabled', false);
    }

    migrationStore.set(CODEBASE_AUTOINDEX_DISABLED_MIGRATION_KEY, true);
  }

  /**
   * Raise auxiliary slot timeouts that still hold the old 15s default.
   *
   * A cold local-model load (e.g. a ~20GB Ollama model into VRAM) can take
   * ~17-22s, which exceeds the original 15s timeout used for titleGeneration,
   * routingClassification, and approvalScoring — so the first call after the
   * model unloads always aborts. DEFAULT_SETTINGS now ships 45s, but
   * electron-store keeps already-persisted values. This one-shot migration only
   * touches slots that still equal the exact old default (15000), so it never
   * clobbers a value the user intentionally customised.
   */
  private migrateAuxiliarySlotTimeouts(): void {
    const migrationStore = this.store as unknown as MigrationStore;
    if (migrationStore.get(AUX_SLOT_TIMEOUT_MIGRATION_KEY) === true) {
      return;
    }

    const OLD_DEFAULT_MS = 15000;
    const NEW_DEFAULT_MS = 45000;
    const SLOTS_TO_RAISE = ['titleGeneration', 'routingClassification', 'approvalScoring'];

    const raw = this.store.get('auxiliaryLlmSlotsJson');
    if (typeof raw === 'string') {
      try {
        const slots = JSON.parse(raw) as Record<string, { timeoutMs?: number } | undefined>;
        let changed = false;
        for (const name of SLOTS_TO_RAISE) {
          const slot = slots[name];
          if (slot && slot.timeoutMs === OLD_DEFAULT_MS) {
            slot.timeoutMs = NEW_DEFAULT_MS;
            changed = true;
          }
        }
        if (changed) {
          logger.info('Raising persisted auxiliary slot timeouts for cold local-model loads');
          this.store.set('auxiliaryLlmSlotsJson', JSON.stringify(slots));
        }
      } catch {
        // Malformed JSON — leave as-is; AuxiliaryLlmService falls back to defaults.
      }
    }

    migrationStore.set(AUX_SLOT_TIMEOUT_MIGRATION_KEY, true);
  }

  /**
   * `allowFrontierFallback` used to be an inert flag persisted as `false` for
   * every slot. It is now enforced: when `false`, a slot will never escalate to
   * the primary (cloud) model and instead uses a deterministic local summary.
   *
   * For the two text slots (compression, memoryDistillation) the new default is
   * `true` so behavior is unchanged for users without a local model. This
   * one-shot migration flips persisted `false → true` for exactly those two
   * slots when they still hold the old default, so existing installs don't get a
   * silent compaction/memory quality regression on upgrade. Slots the user
   * intentionally set to `false` after this lands are preserved (the migration
   * runs once). Advisory slots (titles/classification/scoring) are left as-is.
   */
  private migrateAuxiliaryFrontierFallbackDefault(): void {
    const migrationStore = this.store as unknown as MigrationStore;
    if (migrationStore.get(AUX_FRONTIER_FALLBACK_MIGRATION_KEY) === true) {
      return;
    }

    const SLOTS_TO_ENABLE = ['compression', 'memoryDistillation'];

    const raw = this.store.get('auxiliaryLlmSlotsJson');
    if (typeof raw === 'string') {
      try {
        const slots = JSON.parse(raw) as Record<string, { allowFrontierFallback?: boolean } | undefined>;
        let changed = false;
        for (const name of SLOTS_TO_ENABLE) {
          const slot = slots[name];
          if (slot && slot.allowFrontierFallback === false) {
            slot.allowFrontierFallback = true;
            changed = true;
          }
        }
        if (changed) {
          logger.info('Enabling frontier fallback for compression/memoryDistillation (new default)');
          this.store.set('auxiliaryLlmSlotsJson', JSON.stringify(slots));
        }
      } catch {
        // Malformed JSON — leave as-is; AuxiliaryLlmService falls back to defaults.
      }
    }

    migrationStore.set(AUX_FRONTIER_FALLBACK_MIGRATION_KEY, true);
  }

  private migrateAuxiliarySlotTiers(): void {
    const migrationStore = this.store as unknown as MigrationStore;
    if (migrationStore.get(AUX_SLOT_TIERS_MIGRATION_KEY) === true) {
      return;
    }

    const raw = this.store.get('auxiliaryLlmSlotsJson');
    if (typeof raw === 'string') {
      const updated = backfillSlotTiers(raw);
      if (updated !== null) {
        logger.info('Backfilling auxiliary slot tiers (quick/quality) for existing config');
        this.store.set('auxiliaryLlmSlotsJson', updated);
      }
    }

    migrationStore.set(AUX_SLOT_TIERS_MIGRATION_KEY, true);
  }

  private migrateTitleGenerationBudget(): void {
    const migrationStore = this.store as unknown as MigrationStore;
    if (migrationStore.get(AUX_TITLE_BUDGET_MIGRATION_KEY) === true) {
      return;
    }

    const raw = this.store.get('auxiliaryLlmSlotsJson');
    if (typeof raw === 'string') {
      const updated = raiseSlotOutputBudget(raw, 'titleGeneration', 512);
      if (updated !== null) {
        logger.info('Raising titleGeneration output budget to 512 (was too small for reasoning models)');
        this.store.set('auxiliaryLlmSlotsJson', updated);
      }
    }

    migrationStore.set(AUX_TITLE_BUDGET_MIGRATION_KEY, true);
  }

  /**
   * Seed `defaultModelByProvider` from the legacy `defaultModel` + `defaultCli`
   * on first launch after the per-provider memory feature lands. Subsequent
   * writes are owned by the renderer (ProviderStateService).
   *
   * We do not try to invent values for providers the user has never touched —
   * those fall back to `getPrimaryModelForProvider(provider)` at read time.
   */
  private seedDefaultModelByProvider(): void {
    const existing = this.store.get('defaultModelByProvider');
    if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
      return;
    }

    const defaultCli = this.store.get('defaultCli');
    const defaultModel = this.store.get('defaultModel');
    if (
      typeof defaultCli !== 'string'
      || defaultCli === 'auto'
      || typeof defaultModel !== 'string'
      || defaultModel.trim().length === 0
    ) {
      this.store.set('defaultModelByProvider', {});
      return;
    }

    const seeded: Record<string, string> = { [defaultCli]: defaultModel };
    logger.info('Seeding defaultModelByProvider from legacy defaultModel', {
      defaultCli,
      defaultModel,
    });
    this.store.set('defaultModelByProvider', seeded);
  }

  /**
   * Migrate settings from legacy "claude-orchestrator" to "ai-orchestrator"
   * This runs once on first launch after the rename
   */
  private migrateFromLegacyApp(): void {
    try {
      const currentUserData = app.getPath('userData');
      const legacyUserData = currentUserData.replace(/ai-orchestrator$/i, LEGACY_APP_NAME);

      // Skip if already migrated or no legacy data exists
      if (currentUserData === legacyUserData) return;
      if (!fs.existsSync(legacyUserData)) return;

      // Check if migration already done (current settings exist)
      const currentSettingsPath = path.join(currentUserData, 'settings.json');
      if (fs.existsSync(currentSettingsPath)) return;

      // Ensure current user data directory exists
      if (!fs.existsSync(currentUserData)) {
        fs.mkdirSync(currentUserData, { recursive: true });
      }

      // Migrate settings file
      const legacySettingsPath = path.join(legacyUserData, 'settings.json');
      if (fs.existsSync(legacySettingsPath)) {
        fs.copyFileSync(legacySettingsPath, currentSettingsPath);
        logger.info('Migrated settings from legacy app');
      }

      // Migrate recent directories
      const legacyRecentDirs = path.join(legacyUserData, 'recent-directories.json');
      const currentRecentDirs = path.join(currentUserData, 'recent-directories.json');
      if (fs.existsSync(legacyRecentDirs) && !fs.existsSync(currentRecentDirs)) {
        fs.copyFileSync(legacyRecentDirs, currentRecentDirs);
        logger.info('Migrated recent directories from legacy app');
      }

      // Migrate history database
      const legacyHistory = path.join(legacyUserData, 'history.db');
      const currentHistory = path.join(currentUserData, 'history.db');
      if (fs.existsSync(legacyHistory) && !fs.existsSync(currentHistory)) {
        fs.copyFileSync(legacyHistory, currentHistory);
        logger.info('Migrated history database from legacy app');
      }

      // Migrate RLM database
      const legacyRlm = path.join(legacyUserData, 'rlm.db');
      const currentRlm = path.join(currentUserData, 'rlm.db');
      if (fs.existsSync(legacyRlm) && !fs.existsSync(currentRlm)) {
        fs.copyFileSync(legacyRlm, currentRlm);
        logger.info('Migrated RLM database from legacy app');
      }

      logger.info('Migration from claude-orchestrator complete');
    } catch (error) {
      logger.warn('Migration failed (non-critical)', { error: String(error) });
    }
  }

  /**
   * Get all settings
   */
  getAll(): AppSettings {
    return this.store.store;
  }

  /**
   * Get a single setting value
   */
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.store.get(key);
  }

  /**
   * Set a single setting value
   */
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    const validatedValue = this.validateSetting(key, value);
    const normalizedValue = this.normalizeSetting(key, validatedValue);

    this.store.set(key, normalizedValue);
    this.invalidate(3);
    this.emit('setting-changed', key, normalizedValue);
    this.emit(`setting:${key}`, normalizedValue);
  }

  /**
   * Update multiple settings at once
   */
  update(settings: Partial<AppSettings>): void {
    for (const [key, value] of Object.entries(settings)) {
      const typedKey = key as keyof AppSettings;
      const validatedValue = this.validateSetting(
        typedKey,
        value as AppSettings[keyof AppSettings]
      );
      const normalizedValue = this.normalizeSetting(typedKey, validatedValue);

      this.store.set(typedKey, normalizedValue);
      this.emit('setting-changed', key, normalizedValue);
      this.emit(`setting:${key}`, normalizedValue);
    }
    this.invalidate(3);
    this.emit('settings-updated', this.getAll());
  }

  /**
   * Return fully merged settings, using the level-3 cache when available.
   * Subsequent calls return the same reference until `invalidate()` is called.
   */
  getMerged(): AppSettings {
    if (this.settingsCache.merged !== null) {
      return this.settingsCache.merged;
    }
    const merged = this.store.store;
    this.settingsCache.merged = merged;
    this.settingsCache.mergedAt = Date.now();
    return merged;
  }

  /**
   * Invalidate the settings cache.
   * Level 1 = parsed file cache (cascades to 2 and 3).
   * Level 2 = per-source merged cache (cascades to 3).
   * Level 3 = fully merged cache only.
   * No argument = clear all levels.
   */
  invalidate(level?: 1 | 2 | 3): void {
    // All levels reset the merged (level-3) cache.
    this.settingsCache.merged = null;
    this.settingsCache.mergedAt = 0;
    // Levels 1 and 2 would additionally clear file-parse and source caches
    // if those were implemented. Placeholder for future per-source caching.
    void level;
  }

  /**
   * Reset all settings to defaults
   */
  reset(): void {
    this.store.clear();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const typedKey = key as keyof AppSettings;
      this.store.set(typedKey, value as AppSettings[keyof AppSettings]);
      this.emit('setting-changed', typedKey, value);
      this.emit(`setting:${key}`, value);
    }
    this.invalidate(3);
    this.emit('settings-reset', DEFAULT_SETTINGS);
  }

  /**
   * Reset a single setting to default
   */
  resetOne<K extends keyof AppSettings>(key: K): void {
    this.store.set(key, DEFAULT_SETTINGS[key]);
    this.invalidate(3);
    this.emit('setting-changed', key, DEFAULT_SETTINGS[key]);
    this.emit(`setting:${key}`, DEFAULT_SETTINGS[key]);
  }

  /**
   * Get the storage file path (useful for debugging)
   */
  getPath(): string {
    return this.store.path;
  }
}

// Singleton instance
let settingsManager: SettingsManager | null = null;

export function getSettingsManager(): SettingsManager {
  if (!settingsManager) {
    settingsManager = new SettingsManager();
  }
  return settingsManager;
}
