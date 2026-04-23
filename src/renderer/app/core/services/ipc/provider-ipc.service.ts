/**
 * Provider IPC Service - Provider operations and CLI detection
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse, CopilotModelInfo } from './electron-ipc.service';
import type { ModelDisplayInfo } from '../../../../../shared/types/provider.types';

@Injectable({ providedIn: 'root' })
export class ProviderIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // CLI Detection
  // ============================================

  /**
   * Detect all available CLIs
   */
  async detectClis(force?: boolean): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.detectClis(force);
  }

  /**
   * Detect a single CLI by command
   */
  async detectOneCli(command: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.detectOneCli(command);
  }

  /**
   * Check if a specific CLI is available
   */
  async checkCli(cliType: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.checkCli(cliType);
  }

  /**
   * Test connection to a CLI
   */
  async testCliConnection(command: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.testCliConnection(command);
  }

  /**
   * Scan every PATH location for every install of a given CLI.
   */
  async scanAllCliInstalls(type: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.scanAllCliInstalls(type);
  }

  /**
   * Run the full CLI diagnostic sweep for every supported CLI.
   */
  async diagnoseAllClis(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.diagnoseAllClis();
  }

  // ============================================
  // Copilot
  // ============================================

  /**
   * List available models from Copilot CLI
   * Queries the CLI dynamically, falls back to defaults if unavailable
   */
  async listCopilotModels(): Promise<{ success: boolean; data?: CopilotModelInfo[]; error?: { message: string } }> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listCopilotModels() as Promise<{ success: boolean; data?: CopilotModelInfo[]; error?: { message: string } }>;
  }

  /**
   * List available models for any provider
   * Dynamically queries CLI when supported (Copilot), falls back to static lists
   */
  async listModelsForProvider(provider: string): Promise<{ success: boolean; data?: ModelDisplayInfo[]; error?: { message: string } }> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listModelsForProvider(provider) as Promise<{ success: boolean; data?: ModelDisplayInfo[]; error?: { message: string } }>;
  }

  // ============================================
  // Providers
  // ============================================

  /**
   * List all provider configurations
   */
  async listProviders(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listProviders();
  }

  /**
   * Get status of a specific provider
   */
  async getProviderStatus(providerType: string, forceRefresh?: boolean): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getProviderStatus(providerType, forceRefresh);
  }

  /**
   * Get status of all providers
   */
  async getAllProviderStatus(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getAllProviderStatus();
  }

  /**
   * Update provider configuration
   */
  async updateProviderConfig(providerType: string, config: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updateProviderConfig(providerType, config);
  }

  // ============================================
  // Provider Plugins
  // ============================================

  /**
   * Discover available plugins
   */
  async pluginsDiscover(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsDiscover();
  }

  /**
   * Load a plugin
   */
  async pluginsLoad(pluginId: string, options?: { timeout?: number; sandbox?: boolean }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsLoad(pluginId, options);
  }

  /**
   * Unload a plugin
   */
  async pluginsUnload(pluginId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsUnload(pluginId);
  }

  /**
   * Install a plugin from file
   */
  async pluginsInstall(sourcePath: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsInstall(sourcePath);
  }

  /**
   * Uninstall a plugin
   */
  async pluginsUninstall(pluginId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsUninstall(pluginId);
  }

  /**
   * Get loaded plugins
   */
  async pluginsGetLoaded(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsGetLoaded();
  }

  /**
   * Create a plugin template
   */
  async pluginsCreateTemplate(name: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsCreateTemplate(name);
  }
}
