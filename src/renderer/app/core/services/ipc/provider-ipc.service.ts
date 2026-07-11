/**
 * Provider IPC Service - Provider operations and CLI detection
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse, CopilotModelInfo } from './electron-ipc.service';
import type { ModelDisplayInfo } from '../../../../../shared/types/provider.types';
import type {
  UnifiedModelEntry,
  CatalogStatus,
} from '../../../../../shared/types/unified-model-catalog.types';
import type { LocalModelInventoryEntry } from '../../../../../shared/types/local-model-runtime.types';

export interface UnifiedCatalogSnapshot {
  models: UnifiedModelEntry[];
  status: CatalogStatus;
}

export interface CatalogUpdatedPushPayload {
  totalEntries: number;
  sources: string[];
}

export interface LocalModelInventorySnapshot {
  models: LocalModelInventoryEntry[];
}

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

  /**
   * Update one installed provider CLI.
   */
  async updateCli(type: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updateCli(type);
  }

  /**
   * Update every installed provider CLI with a known updater.
   */
  async updateAllClis(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updateAllClis();
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
   * Dynamically queries CLI when supported (Copilot/Cursor), falls back to static lists
   */
  async listModelsForProvider(provider: string): Promise<{ success: boolean; data?: ModelDisplayInfo[]; error?: { message: string } }> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listModelsForProvider(provider) as Promise<{ success: boolean; data?: ModelDisplayInfo[]; error?: { message: string } }>;
  }

  /**
   * Push CLI-discovered models into the main-process unified catalog (A1) so
   * backend services (routing, cost accounting) and the unified-catalog IPC see
   * live models. Fire-and-forget from discovery; never throws.
   */
  async pushCliDiscoveredModels(provider: string, models: ModelDisplayInfo[]): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.pushCliDiscoveredModels(
        provider,
        models.map((m) => ({ id: m.id, name: m.name, tier: m.tier, pinned: m.pinned, family: m.family })),
      );
    } catch {
      // Catalog enrichment is best-effort; discovery already updated the picker.
    }
  }

  /**
   * Read the full unified model catalog from the main process.
   * Includes static, models.dev, override, custom, and CLI-discovered entries.
   */
  async getUnifiedModelCatalog(): Promise<{
    success: boolean;
    data?: UnifiedCatalogSnapshot;
    error?: { message: string };
  }> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getUnifiedModelCatalog() as Promise<{
      success: boolean;
      data?: UnifiedCatalogSnapshot;
      error?: { message: string };
    }>;
  }

  async getLocalModelInventory(): Promise<{
    success: boolean;
    data?: LocalModelInventorySnapshot;
    error?: { message: string };
  }> {
    if (!this.api?.getLocalModelInventory) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.getLocalModelInventory() as Promise<{
      success: boolean;
      data?: LocalModelInventorySnapshot;
      error?: { message: string };
    }>;
  }

  async qualifyLocalReviewer(selectorId: string): Promise<{
    success: boolean;
    data?: { status: 'verified' | 'unverified'; reason?: string };
    error?: { message: string };
  }> {
    if (!this.api?.qualifyLocalReviewer) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.qualifyLocalReviewer(selectorId) as Promise<{
      success: boolean;
      data?: { status: 'verified' | 'unverified'; reason?: string };
      error?: { message: string };
    }>;
  }

  /**
   * Subscribe to unified-catalog refreshes (main -> renderer). Returns an
   * unsubscribe function; a no-op outside Electron.
   */
  onModelsCatalogUpdated(callback: (payload: CatalogUpdatedPushPayload) => void): () => void {
    if (!this.api?.onModelsCatalogUpdated) return () => { /* no-op outside Electron */ };
    return this.api.onModelsCatalogUpdated(callback);
  }

  onLocalModelInventoryUpdated(callback: (payload: LocalModelInventorySnapshot) => void): () => void {
    if (!this.api?.onLocalModelInventoryUpdated) return () => { /* no-op outside Electron */ };
    return this.api.onLocalModelInventoryUpdated((payload) => {
      callback(payload as LocalModelInventorySnapshot);
    });
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
