/**
 * Settings Store - Manages application settings state
 */

import { Injectable, signal, computed, effect, inject } from '@angular/core';
import type { AppSettings, ThemeMode } from '../../../../shared/types/settings.types';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../../shared/types/settings.types';
import { SettingsIpcService } from '../services/ipc/settings-ipc.service';

@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private settingsIpc = inject(SettingsIpcService);

  // Settings state
  private _settings = signal<AppSettings>(DEFAULT_SETTINGS);
  private _loading = signal(false);
  private _error = signal<string | null>(null);

  // Public readonly signals
  readonly settings = this._settings.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  // Computed values for common settings
  readonly defaultYoloMode = computed(() => this._settings().defaultYoloMode);
  readonly defaultWorkingDirectory = computed(() => this._settings().defaultWorkingDirectory);
  readonly defaultCli = computed(() => this._settings().defaultCli);
  readonly theme = computed(() => this._settings().theme);
  readonly maxChildrenPerParent = computed(() => this._settings().maxChildrenPerParent);
  readonly fontSize = computed(() => this._settings().fontSize);
  readonly showToolMessages = computed(() => this._settings().showToolMessages);
  readonly showThinking = computed(() => this._settings().showThinking);
  readonly thinkingDefaultExpanded = computed(() => this._settings().thinkingDefaultExpanded);
  readonly contextWarningThreshold = computed(() => this._settings().contextWarningThreshold);

  // Settings metadata for UI
  readonly metadata = SETTINGS_METADATA;

  // Group settings by category
  readonly generalSettings = computed(() =>
    SETTINGS_METADATA.filter(m => m.category === 'general')
  );
  readonly orchestrationSettings = computed(() =>
    SETTINGS_METADATA.filter(m => m.category === 'orchestration')
  );
  readonly memorySettings = computed(() =>
    SETTINGS_METADATA.filter(m => m.category === 'memory')
  );
  readonly displaySettings = computed(() =>
    SETTINGS_METADATA.filter(m => m.category === 'display')
  );
  readonly advancedSettings = computed(() =>
    SETTINGS_METADATA.filter(m => m.category === 'advanced')
  );
  readonly reviewSettings = computed(() =>
    SETTINGS_METADATA.filter(s => s.category === 'review')
  );

  // Remote Nodes
  readonly remoteNodesEnabled = computed(() => this._settings().remoteNodesEnabled);
  readonly remoteNodesServerPort = computed(() => this._settings().remoteNodesServerPort);
  readonly remoteNodesServerHost = computed(() => this._settings().remoteNodesServerHost);
  readonly remoteNodesEnrollmentToken = computed(() => this._settings().remoteNodesEnrollmentToken);
  readonly remoteNodesAutoOffloadBrowser = computed(() => this._settings().remoteNodesAutoOffloadBrowser);
  readonly remoteNodesAutoOffloadGpu = computed(() => this._settings().remoteNodesAutoOffloadGpu);
  readonly remoteNodesNamespace = computed(() => this._settings().remoteNodesNamespace);
  readonly remoteNodesRequireTls = computed(() => this._settings().remoteNodesRequireTls);
  readonly remoteNodesTlsMode = computed(() => this._settings().remoteNodesTlsMode);
  readonly remoteNodesRegisteredNodes = computed(() => {
    try {
      return JSON.parse(this._settings().remoteNodesRegisteredNodes) as Record<string, unknown>;
    } catch {
      return {};
    }
  });

  private unsubscribe: (() => void) | null = null;

  constructor() {
    // Apply theme on settings change
    effect(() => {
      this.applyTheme(this._settings().theme);
    });

    // Apply font size on settings change
    effect(() => {
      this.applyFontSize(this._settings().fontSize);
    });
  }

  /**
   * Initialize the store - load settings from main process
   */
  async initialize(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    try {
      const response = await this.settingsIpc.getSettings();
      if (response.success && response.data) {
        this._settings.set(response.data as AppSettings);
      }

      // Listen for settings changes from main process
      this.unsubscribe = this.settingsIpc.onSettingsChanged((data: unknown) => {
        if (data && typeof data === 'object' && 'settings' in data) {
          this._settings.set((data as { settings: AppSettings }).settings);
        } else if (data && typeof data === 'object' && 'key' in data && 'value' in data) {
          const { key, value } = data as { key: string; value: unknown };
          // Full import happened — reload all settings
          if (key === '__imported__') {
            void this.reload();
            return;
          }
          this._settings.update(current => ({
            ...current,
            [key]: value,
          }));
        }
      });
    } catch (error) {
      this._error.set((error as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Set a single setting
   */
  async set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
    try {
      // Optimistically update local state
      this._settings.update(current => ({
        ...current,
        [key]: value,
      }));

      const response = await this.settingsIpc.setSetting(key, value);
      if (!response.success) {
        throw new Error('Failed to save setting');
      }
    } catch (error) {
      this._error.set((error as Error).message);
      // Reload settings to restore consistent state
      await this.initialize();
    }
  }

  /**
   * Update multiple settings at once
   */
  async update(settings: Partial<AppSettings>): Promise<void> {
    try {
      // Optimistically update local state
      this._settings.update(current => ({
        ...current,
        ...settings,
      }));

      const response = await this.settingsIpc.updateSettings(settings as Record<string, unknown>);
      if (!response.success) {
        throw new Error('Failed to save settings');
      }
    } catch (error) {
      this._error.set((error as Error).message);
      await this.initialize();
    }
  }

  /**
   * Reset all settings to defaults
   */
  async reset(): Promise<void> {
    try {
      const response = await this.settingsIpc.resetSettings();
      if (response.success && response.data) {
        this._settings.set(response.data as AppSettings);
      }
    } catch (error) {
      this._error.set((error as Error).message);
    }
  }

  /**
   * Reset a single setting to default
   */
  async resetOne<K extends keyof AppSettings>(key: K): Promise<void> {
    try {
      const response = await this.settingsIpc.resetSetting(key);
      if (response.success) {
        this._settings.update(current => ({
          ...current,
          [key]: DEFAULT_SETTINGS[key],
        }));
      }
    } catch (error) {
      this._error.set((error as Error).message);
    }
  }

  /**
   * Reload all settings from the main process (e.g. after import)
   */
  async reload(): Promise<void> {
    try {
      const response = await this.settingsIpc.getSettings();
      if (response.success && response.data) {
        this._settings.set(response.data as AppSettings);
      }
    } catch (error) {
      this._error.set((error as Error).message);
    }
  }

  /**
   * Get the value of a setting by key
   */
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this._settings()[key];
  }

  /**
   * Apply theme to document
   */
  private applyTheme(theme: ThemeMode): void {
    const root = document.documentElement;

    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }

  /**
   * Apply font size to document
   */
  private applyFontSize(fontSize: number): void {
    document.documentElement.style.setProperty('--output-font-size', `${fontSize}px`);
  }

  // ============================================
  // Project Config Operations
  // ============================================

  async resolveConfig(workingDirectory?: string): Promise<Record<string, unknown> | null> {
    const resp = await this.settingsIpc.resolveConfig(workingDirectory);
    return resp.success ? (resp.data as Record<string, unknown>) : null;
  }

  async getProjectConfig(configPath: string): Promise<Record<string, unknown> | null> {
    const resp = await this.settingsIpc.getProjectConfig(configPath);
    return resp.success ? (resp.data as Record<string, unknown>) : null;
  }

  async saveProjectConfig(configPath: string, config: Record<string, unknown>): Promise<boolean> {
    const resp = await this.settingsIpc.saveProjectConfig(configPath, config);
    return resp.success;
  }

  async findProjectConfig(startDir: string): Promise<string | null> {
    const resp = await this.settingsIpc.findProjectConfig(startDir);
    return resp.success ? (resp.data as string) : null;
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }
}
