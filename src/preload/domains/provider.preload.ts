import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

export function createProviderDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
  withAuth: (payload?: Record<string, unknown>) => Record<string, unknown> & { ipcAuthToken?: string } = (p = {}) => p
) {
  return {
    // ============================================
    // CLI Detection
    // ============================================

    /**
     * Detect all available CLIs
     */
    detectClis: (force?: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_DETECT_ALL, force ? { force: true } : undefined);
    },

    /**
     * Detect a single CLI by command
     */
    detectOneCli: (command: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_DETECT_ONE, { command });
    },

    /**
     * Check if a specific CLI is available
     */
    checkCli: (cliType: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_CHECK, cliType);
    },

    /**
     * Test connection to a CLI
     */
    testCliConnection: (command: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_TEST_CONNECTION, { command });
    },

    /**
     * Scan all PATH locations for every install of a given CLI.
     * Used by the CLI Health tab to surface shadow installs.
     */
    scanAllCliInstalls: (type: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_SCAN_ALL_INSTALLS, { type });
    },

    /**
     * Run the full CLI diagnostic sweep (scan + ProviderDoctor probes) for
     * every supported CLI.  Used by the CLI Health tab.
     */
    diagnoseAllClis: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_DIAGNOSE_ALL);
    },

    /**
     * Update one installed provider CLI using the main process' fixed update
     * plan for that provider.
     */
    updateCli: (type: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_UPDATE_ONE, withAuth({ type }));
    },

    /**
     * Update every installed provider CLI that has a known safe updater.
     */
    updateAllClis: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CLI_UPDATE_ALL, withAuth({}));
    },

    // ============================================
    // Copilot
    // ============================================

    /**
     * List available models from Copilot CLI
     * Queries the CLI dynamically, falls back to defaults if unavailable
     */
    listCopilotModels: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COPILOT_LIST_MODELS);
    },

    /**
     * List available models for any provider
     * Dynamically queries CLI when supported (Copilot), falls back to static lists
     */
    listModelsForProvider: (provider: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PROVIDER_LIST_MODELS, { provider });
    },

    // ============================================
    // Providers
    // ============================================

    /**
     * List all provider configurations
     */
    listProviders: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PROVIDER_LIST);
    },

    /**
     * Get status of a specific provider
     */
    getProviderStatus: (
      providerType: string,
      forceRefresh?: boolean
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PROVIDER_STATUS, {
        providerType,
        forceRefresh
      });
    },

    /**
     * Get status of all providers
     */
    getAllProviderStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PROVIDER_STATUS_ALL);
    },

    /**
     * Update provider configuration
     */
    updateProviderConfig: (
      providerType: string,
      config: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.PROVIDER_UPDATE_CONFIG,
        withAuth({ providerType, config })
      );
    },

    // ============================================
    // Provider Plugins (12.2)
    // ============================================

    /**
     * Discover available plugins
     */
    pluginsDiscover: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLUGINS_DISCOVER);
    },

    /**
     * Load a plugin
     */
    pluginsLoad: (
      pluginId: string,
      options?: { timeout?: number; sandbox?: boolean }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLUGINS_LOAD, { pluginId, options });
    },

    /**
     * Unload a plugin
     */
    pluginsUnload: (pluginId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLUGINS_UNLOAD, { pluginId });
    },

    /**
     * Install a plugin from file
     */
    pluginsInstall: (sourcePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLUGINS_INSTALL, { sourcePath });
    },

    /**
     * Uninstall a plugin
     */
    pluginsUninstall: (pluginId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLUGINS_UNINSTALL, { pluginId });
    },

    /**
     * Get loaded plugins
     */
    pluginsGetLoaded: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLUGINS_GET_LOADED);
    },

    /**
     * Create a plugin template
     */
    pluginsCreateTemplate: (name: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLUGINS_CREATE_TEMPLATE, { name });
    },

    /**
     * Listen for plugin loaded events
     */
    onPluginLoaded: (
      callback: (data: { pluginId: string }) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { pluginId: string }) =>
        callback(data);
      ipcRenderer.on('plugins:loaded', handler);
      return () => ipcRenderer.removeListener('plugins:loaded', handler);
    },

    /**
     * Listen for plugin unloaded events
     */
    onPluginUnloaded: (
      callback: (data: { pluginId: string }) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { pluginId: string }) =>
        callback(data);
      ipcRenderer.on('plugins:unloaded', handler);
      return () => ipcRenderer.removeListener('plugins:unloaded', handler);
    },

    /**
     * Listen for plugin error events
     */
    onPluginError: (
      callback: (data: { pluginId: string; error: string }) => void
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        data: { pluginId: string; error: string }
      ) => callback(data);
      ipcRenderer.on('plugins:error', handler);
      return () => ipcRenderer.removeListener('plugins:error', handler);
    },

    // ============================================
    // Runtime Events
    // ============================================

    /**
     * Listen for normalized provider runtime events (status/output/exit/etc.)
     * emitted by the main-process `BaseProvider.events$` stream.
     */
    onProviderRuntimeEvent: (
      callback: (envelope: ProviderRuntimeEventEnvelope) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, envelope: ProviderRuntimeEventEnvelope) =>
        callback(envelope);
      ipcRenderer.on(ch.PROVIDER_RUNTIME_EVENT, handler);
      return () => ipcRenderer.removeListener(ch.PROVIDER_RUNTIME_EVENT, handler);
    },

    // ============================================
    // Model Discovery
    // ============================================

    modelDiscover: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MODEL_DISCOVER),

    modelVerify: (payload: { modelId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MODEL_VERIFY, payload),

    modelSetOverride: (payload: { modelId: string; config: Record<string, unknown> }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MODEL_SET_OVERRIDE, payload),

    modelRemoveOverride: (payload: { modelId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MODEL_REMOVE_OVERRIDE, payload),

    // ============================================
    // Model Routing
    // ============================================

    routingGetConfig: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.ROUTING_GET_CONFIG),

    routingUpdateConfig: (config: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.ROUTING_UPDATE_CONFIG, config),

    routingPreview: (payload: { task: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.ROUTING_PREVIEW, payload),

    routingGetTier: (payload: { modelId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.ROUTING_GET_TIER, payload),

    // ============================================
    // Hot Model Switching
    // ============================================

    hotSwitchGetConfig: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.HOT_SWITCH_GET_CONFIG),

    hotSwitchUpdateConfig: (config: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.HOT_SWITCH_UPDATE_CONFIG, config),

    hotSwitchPerform: (payload: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.HOT_SWITCH_PERFORM, payload),

    hotSwitchGetStats: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.HOT_SWITCH_GET_STATS),
  };
}
