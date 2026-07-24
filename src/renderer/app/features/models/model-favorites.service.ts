/**
 * Model favourites mirror — copies the picker's ★ favourites into
 * `AppSettings.modelPickerFavorites` so the main-process automation runner can
 * read them at fire time.
 *
 * The model picker keeps localStorage (`compact-model-picker:favorites:v1`) as
 * its own source of truth for the ★ tab UI; this service mirrors that list into
 * a setting the renderer cannot otherwise expose to main. It also runs a
 * one-time migration copying an existing localStorage list up on first boot
 * after upgrade, so users who already curated favourites don't have to re-toggle
 * a star to populate the setting.
 */

import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';

/** Same localStorage key the picker panel writes; kept in sync deliberately. */
const FAVORITES_STORAGE_KEY = 'compact-model-picker:favorites:v1';

@Injectable({ providedIn: 'root' })
export class ModelFavoritesService {
  private readonly settingsStore = inject(SettingsStore);
  private readonly settingsIpc = inject(SettingsIpcService);
  private migrationChecked = false;

  private readonly _favorites = signal<string[]>([]);
  /** Ordered `provider:modelId` favourite keys, mirrored from settings. */
  readonly favorites = this._favorites.asReadonly();

  constructor() {
    // Keep the in-memory signal in sync with the setting (initial load + later
    // reloads from disk / other windows), and run the localStorage → setting
    // migration exactly once, only after real settings have loaded (so an empty
    // DEFAULT_SETTINGS snapshot never triggers a spurious migration).
    effect(() => {
      const initialized = this.settingsStore.isInitialized();
      const incoming = normalizeFavoriteKeys(this.settingsStore.settings().modelPickerFavorites);

      const current = untracked(() => this._favorites());
      if (!keysEqual(current, incoming)) {
        this._favorites.set(incoming);
      }

      if (initialized && !this.migrationChecked) {
        this.migrationChecked = true;
        untracked(() => this.maybeMigrateFromLocalStorage(incoming));
      }
    });

    this.settingsIpc.onSettingsChanged((data: unknown) => {
      const change = data as { key?: string; value?: unknown; settings?: Record<string, unknown> };
      if (change.key === 'modelPickerFavorites') {
        this._favorites.set(normalizeFavoriteKeys(change.value));
        return;
      }
      if (change.settings && 'modelPickerFavorites' in change.settings) {
        this._favorites.set(normalizeFavoriteKeys(change.settings['modelPickerFavorites']));
      }
    });
  }

  /** Mirror an ordered favourites list into the setting the runner reads. */
  writeFavorites(keys: string[]): void {
    const normalized = normalizeFavoriteKeys(keys);
    this._favorites.set(normalized);
    void this.settingsIpc.setSetting('modelPickerFavorites', normalized);
  }

  /**
   * One-time migration: if the setting is still empty but the picker has a saved
   * localStorage list, copy it up. Never copies `DEFAULT_FAVORITE_MODEL_KEYS`
   * (an uncustomised install has no saved localStorage list, so nothing is
   * copied and the setting stays empty = today's fallback semantics).
   */
  private maybeMigrateFromLocalStorage(currentSetting: string[]): void {
    if (currentSetting.length > 0) return;
    const stored = readLocalStorageFavorites();
    if (stored.length === 0) return;
    this.writeFavorites(stored);
  }
}

function normalizeFavoriteKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function readLocalStorageFavorites(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (raw === null) return [];
    return normalizeFavoriteKeys(JSON.parse(raw));
  } catch {
    return [];
  }
}

function keysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
