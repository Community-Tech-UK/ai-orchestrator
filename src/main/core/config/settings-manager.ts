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
import { getLogger } from '../../logging/logger';

const logger = getLogger('SettingsManager');

/**
 * Legacy app name for migration purposes
 */
const LEGACY_APP_NAME = 'claude-orchestrator';

// Type for the internal store with the methods we need
interface Store<T> {
  store: T;
  path: string;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  set(object: Partial<T>): void;
  clear(): void;
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
    const normalizedValue =
      key === 'defaultCli' && value === 'openai'
        ? ('codex' as AppSettings[K])
        : value;

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
      const normalizedValue =
        key === 'defaultCli' && value === 'openai'
          ? 'codex'
          : value;

      this.store.set(
        key as keyof AppSettings,
        normalizedValue as AppSettings[keyof AppSettings]
      );
      this.emit('setting-changed', key, normalizedValue);
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
      this.store.set(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);
    }
    this.emit('settings-reset', DEFAULT_SETTINGS);
  }

  /**
   * Reset a single setting to default
   */
  resetOne<K extends keyof AppSettings>(key: K): void {
    this.store.set(key, DEFAULT_SETTINGS[key]);
    this.emit('setting-changed', key, DEFAULT_SETTINGS[key]);
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
