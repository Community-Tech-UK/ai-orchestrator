/**
 * Settings IPC Service - Settings and configuration management
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class SettingsIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  // ============================================
  // Settings
  // ============================================

  /**
   * Get all settings
   */
  async getSettings(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getSettings();
  }

  /**
   * Set a single setting
   */
  async setSetting(key: string, value: unknown): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.setSetting(key, value);
  }

  /**
   * Update multiple settings
   */
  async updateSettings(settings: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updateSettings(settings);
  }

  /**
   * Reset all settings to defaults
   */
  async resetSettings(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.resetSettings();
  }

  /**
   * Reset a single setting to its default
   */
  async resetSetting(key: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.resetSetting(key);
  }

  /**
   * Listen for settings changes
   */
  onSettingsChanged(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onSettingsChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  // ============================================
  // Export / Import
  // ============================================

  /**
   * Export all settings to a JSON file (shows native save dialog)
   */
  async exportSettings(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.exportSettings();
  }

  /**
   * Import settings from a JSON file (shows native open dialog)
   */
  async importSettings(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.importSettings();
  }

  // ============================================
  // Configuration (Hierarchical)
  // ============================================

  /**
   * Resolve configuration for a working directory
   * Returns merged config with source tracking (project > user > default)
   */
  async resolveConfig(workingDirectory?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.resolveConfig(workingDirectory);
  }

  /**
   * Get project config from a specific path
   */
  async getProjectConfig(configPath: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getProjectConfig(configPath);
  }

  /**
   * Save project config to a specific path
   */
  async saveProjectConfig(configPath: string, config: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.saveProjectConfig(configPath, config);
  }

  /**
   * Create a new project config file
   */
  async createProjectConfig(projectDir: string, config?: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createProjectConfig(projectDir, config);
  }

  /**
   * Find project config path by searching up the directory tree
   */
  async findProjectConfig(startDir: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.findProjectConfig(startDir);
  }

  // ============================================
  // Remote Config
  // ============================================

  /**
   * Fetch remote config
   */
  async remoteConfigFetch(force?: boolean): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigFetch(force);
  }

  /**
   * Get config value
   */
  async remoteConfigGet(key: string, defaultValue?: unknown): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigGet(key, defaultValue);
  }

  /**
   * Set config source
   */
  async remoteConfigSetSource(source: {
    type: 'url' | 'file' | 'git';
    location: string;
    refreshInterval?: number;
    branch?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigSetSource(source);
  }

  /**
   * Get config status
   */
  async remoteConfigStatus(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigStatus();
  }

  /**
   * Listen for remote config updates
   */
  onRemoteConfigUpdated(callback: (config: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onRemoteConfigUpdated((config) => {
      this.ngZone.run(() => callback(config));
    });
  }

  /**
   * Listen for remote config errors
   */
  onRemoteConfigError(callback: (error: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onRemoteConfigError((error) => {
      this.ngZone.run(() => callback(error));
    });
  }
}
