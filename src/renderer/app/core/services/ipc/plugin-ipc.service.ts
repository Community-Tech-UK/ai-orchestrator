/**
 * Plugin IPC Service - Plugin discovery, loading, and management
 */
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { PluginPackageSource } from '@contracts/schemas/plugin';

@Injectable({ providedIn: 'root' })
export class PluginIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  // ============================================
  // Plugin Operations
  // ============================================

  /**
   * Discover available plugins
   */
  async pluginsDiscover(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsDiscover();
  }

  /**
   * Load a plugin by ID with optional config
   */
  async pluginsLoad(pluginId: string, options?: { timeout?: number; sandbox?: boolean }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsLoad(pluginId, options);
  }

  /**
   * Unload a plugin by ID
   */
  async pluginsUnload(pluginId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsUnload(pluginId);
  }

  /**
   * Install a plugin from a source path
   */
  async pluginsInstall(sourcePath: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsInstall(sourcePath);
  }

  /**
   * Uninstall a plugin by ID
   */
  async pluginsUninstall(pluginId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsUninstall(pluginId);
  }

  /**
   * Get all currently loaded plugins
   */
  async pluginsGetLoaded(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsGetLoaded();
  }

  /**
   * Create a plugin template with the given name
   */
  async pluginsCreateTemplate(name: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsCreateTemplate(name);
  }

  // ============================================
  // Runtime Plugin Package Operations
  // ============================================

  async runtimePluginsList(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsList();
  }

  async runtimePluginsValidate(source: PluginPackageSource): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsValidate(source);
  }

  async runtimePluginsInstall(source: PluginPackageSource): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsInstall(source);
  }

  async runtimePluginsUpdate(pluginId: string, source?: PluginPackageSource): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsUpdate(pluginId, source);
  }

  async runtimePluginsPrune(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsPrune();
  }

  async runtimePluginsUninstall(pluginId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsUninstall(pluginId);
  }

  // ============================================
  // Plugin Events
  // ============================================

  /**
   * Subscribe to plugin loaded events.
   * Returns an unsubscribe function.
   */
  onPluginLoaded(callback: (data: { pluginId: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPluginLoaded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Subscribe to plugin unloaded events.
   * Returns an unsubscribe function.
   */
  onPluginUnloaded(callback: (data: { pluginId: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPluginUnloaded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Subscribe to plugin error events.
   * Returns an unsubscribe function.
   */
  onPluginError(callback: (data: { pluginId: string; error: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPluginError((data) => {
      this.ngZone.run(() => callback(data));
    });
  }
}
