/**
 * Settings Manager - Manages application settings with persistence
 */

import ElectronStore from 'electron-store';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings } from '../../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { getLogger } from '../../logging/logger';
import { withLockSync } from '../../util/file-lock';
import { PAUSE_SETTING_VALIDATORS, type Validator } from './settings-validators';
import {
  computeDirtyPaths,
  detectConflicts,
  mergeDirtyPaths,
  type SettingsWriteContext,
} from './settings-dirty-merge';
import { migrateFromLegacyApp, runSettingsMigrations } from './settings-migrations';

export type { SettingsConflict, SettingsWriteContext } from './settings-dirty-merge';
const logger = getLogger('SettingsManager');
const SETTINGS_LOCK_TIMEOUT_MS = 5000;
const SETTINGS_LOCK_RETRY_INTERVAL_MS = 50;

/**
 * Ordered config source hierarchy — later sources take precedence.
 * Merge order: User (global) -> Project (repo-local) -> Local (gitignored) -> Env -> CLI args.
 * Motivated by claw-code ConfigSource enum (claude2.md section 9.1).
 */
export const CONFIG_SOURCE_PRECEDENCE = ['user', 'project', 'local', 'env', 'cli'] as const;
export type ConfigSourceLevel = typeof CONFIG_SOURCE_PRECEDENCE[number];

// Type for the internal store with the methods we need
interface Store<T> {
  store: T;
  path: string;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  set(key: string, value: unknown): void;
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

  /**
   * In-memory settings version counter, bumped after every durable write. The
   * settings JSON has no metadata section (electron-store persists a flat
   * `AppSettings`), so the version stays in memory and conflicts are detected
   * by re-reading the file under the write lock.
   */
  private version = 0;

  /**
   * Last-known settings snapshot — baseline for dirty-path diffing and
   * conflict detection. `null` until constructor migrations finish, so
   * migration writes keep today's wholesale-write semantics.
   */
  private lastKnown: AppSettings | null = null;

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

  private persistSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.writeDirtyFields({ [key]: value } as Partial<AppSettings>);
  }

  /**
   * Persist dirty fields under the settings file lock: re-read disk, detect
   * concurrent same-field conflicts against the last-known snapshot, and merge
   * ONLY the dirty dot-paths over the latest disk state so unrelated concurrent
   * changes (including sibling keys of nested objects) survive.
   *
   * Conflict policy: attempted values win (last-write-wins, matching the
   * pre-existing behavior); conflicts surface via the 'settings-conflict'
   * event and a warning log after the write succeeds. Returns the per-key
   * values actually persisted (merged) for change-event emission.
   */
  private writeDirtyFields(dirty: Partial<AppSettings>): Partial<AppSettings> {
    const dirtyKeys = Object.keys(dirty) as (keyof AppSettings)[];
    if (dirtyKeys.length === 0) return {};

    const attempted = dirty as Record<string, unknown>;
    const expected = this.lastKnown as Record<string, unknown> | null;
    const dirtyPaths = dirtyKeys.flatMap((key) =>
      computeDirtyPaths(String(key), attempted[String(key)], expected?.[String(key)], expected !== null));
    const context: SettingsWriteContext = { dirtyPaths, expectedVersion: this.version };

    const { conflicts, persisted } = this.withSettingsWriteLock(() => {
      const disk = this.store.store as unknown as Record<string, unknown>;
      const found = expected === null ? [] : detectConflicts(dirtyPaths, disk, expected, attempted);
      const merged = mergeDirtyPaths(disk, attempted, dirtyPaths);
      const persistedEntries = dirtyKeys.map((key) => [key, merged[String(key)]] as const);

      if (persistedEntries.length === 1) {
        this.store.set(String(persistedEntries[0][0]), persistedEntries[0][1]);
      } else {
        this.store.set(Object.fromEntries(persistedEntries) as Partial<AppSettings>);
      }

      this.lastKnown = merged as unknown as AppSettings;
      this.version++;
      return {
        conflicts: found,
        persisted: Object.fromEntries(persistedEntries) as Partial<AppSettings>,
      };
    });

    if (conflicts.length > 0) {
      logger.warn('Concurrent settings write conflict; attempted values win (last-write-wins)', {
        paths: conflicts.map((conflict) => conflict.path),
        expectedVersion: context.expectedVersion,
      });
      this.emit('settings-conflict', conflicts, context);
    }
    return persisted;
  }

  private persistRawSetting(key: string, value: unknown): void {
    this.withSettingsWriteLock(() => {
      this.store.set(key, value);
    });
  }

  private withSettingsWriteLock<T>(fn: () => T): T {
    fs.mkdirSync(path.dirname(this.store.path), { recursive: true });
    return withLockSync(`${this.store.path}.lock`, fn, {
      purpose: 'settings-write',
      timeoutMs: SETTINGS_LOCK_TIMEOUT_MS,
      retryIntervalMs: SETTINGS_LOCK_RETRY_INTERVAL_MS,
    });
  }

  constructor() {
    super();

    // Attempt migration from legacy app data before initializing store
    migrateFromLegacyApp();

    // Cast to our Store interface to work around ESM type resolution issues
    this.store = new ElectronStore<AppSettings>({
      name: 'settings',
      defaults: DEFAULT_SETTINGS,
    }) as unknown as Store<AppSettings>;

    // One-shot upgrade migrations (see settings-migrations.ts for each one's
    // rationale and idempotency guard). Runs before the lastKnown baseline is
    // captured, so migration writes keep wholesale-write semantics.
    runSettingsMigrations({
      get: (key) => this.store.get(key as keyof AppSettings),
      persistSetting: (key, value) =>
        this.persistSetting(key as keyof AppSettings, value as AppSettings[keyof AppSettings]),
      persistRawSetting: (key, value) => this.persistRawSetting(key, value),
    });

    // Baseline snapshot for field-level dirty diffing and conflict detection.
    // Captured after migrations so migration writes stay wholesale.
    this.lastKnown = this.store.store;
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

    const persisted = this.writeDirtyFields({ [key]: normalizedValue } as Partial<AppSettings>);
    const persistedValue = persisted[key] as AppSettings[K];
    this.invalidate(3);
    this.emit('setting-changed', key, persistedValue);
    this.emit(`setting:${key}`, persistedValue);
  }

  /**
   * Update multiple settings at once
   */
  update(settings: Partial<AppSettings>): void {
    const normalizedEntries: [keyof AppSettings, AppSettings[keyof AppSettings]][] = [];
    for (const [key, value] of Object.entries(settings)) {
      const typedKey = key as keyof AppSettings;
      const validatedValue = this.validateSetting(
        typedKey,
        value as AppSettings[keyof AppSettings]
      );
      const normalizedValue = this.normalizeSetting(typedKey, validatedValue);

      normalizedEntries.push([typedKey, normalizedValue]);
    }

    const normalizedSettings = Object.fromEntries(normalizedEntries) as Partial<AppSettings>;
    const persisted = this.writeDirtyFields(normalizedSettings);
    this.invalidate(3);
    for (const [key] of normalizedEntries) {
      const persistedValue = persisted[key];
      this.emit('setting-changed', key, persistedValue);
      this.emit(`setting:${String(key)}`, persistedValue);
    }
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
    this.withSettingsWriteLock(() => {
      this.store.clear();
      this.store.set(DEFAULT_SETTINGS);
      this.lastKnown = this.store.store;
      this.version++;
    });
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const typedKey = key as keyof AppSettings;
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
    const persisted = this.writeDirtyFields(
      { [key]: DEFAULT_SETTINGS[key] } as Partial<AppSettings>,
    );
    const persistedValue = persisted[key] as AppSettings[K];
    this.invalidate(3);
    this.emit('setting-changed', key, persistedValue);
    this.emit(`setting:${key}`, persistedValue);
  }

  /**
   * Current in-memory settings version. Bumps after every durable write;
   * `SettingsWriteContext.expectedVersion` captures it at write time.
   */
  getVersion(): number {
    return this.version;
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
