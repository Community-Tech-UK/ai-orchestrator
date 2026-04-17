/**
 * Provider and Plugin IPC Handlers
 * Handles provider configuration and plugin management
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import type { ProviderType } from '../../../shared/types/provider.types';
import { getProviderRegistry } from '../../providers';
import { getProviderPluginsManager } from '../../providers/provider-plugins';
import type { WindowManager } from '../../window-manager';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  PluginsCreateTemplatePayloadSchema,
  PluginsGetMetaPayloadSchema,
  PluginsGetPayloadSchema,
  PluginsInstallPayloadSchema,
  PluginsLoadPayloadSchema,
  PluginsUninstallPayloadSchema,
  PluginsUnloadPayloadSchema,
  ProviderStatusPayloadSchema,
  ProviderUpdateConfigPayloadSchema,
} from '@contracts/schemas/provider';

interface RegisterProviderHandlersDeps {
  windowManager: WindowManager;
  ensureAuthorized: (
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown
  ) => IpcResponse | null;
}

export function registerProviderHandlers(
  deps: RegisterProviderHandlersDeps
): void {
  const registry = getProviderRegistry();
  const pluginManager = getProviderPluginsManager();

  // ============================================
  // Provider Handlers
  // ============================================

  // List all provider configurations
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_LIST,
    async (): Promise<IpcResponse> => {
      try {
        const configs = registry.getAllConfigs();
        return {
          success: true,
          data: configs
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get status of a specific provider
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_STATUS,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ProviderStatusPayloadSchema, payload, 'PROVIDER_STATUS');
        const status = await registry.checkProviderStatus(
          validated.providerType as ProviderType,
          validated.forceRefresh
        );
        return {
          success: true,
          data: status
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get status of all providers
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_STATUS_ALL,
    async (): Promise<IpcResponse> => {
      try {
        const statuses = await registry.checkAllProviderStatus();
        // Convert Map to object for IPC
        const statusObj: Record<string, unknown> = {};
        for (const [type, status] of statuses) {
          statusObj[type] = status;
        }
        return {
          success: true,
          data: statusObj
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_STATUS_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update provider configuration
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_UPDATE_CONFIG,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.PROVIDER_UPDATE_CONFIG,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(ProviderUpdateConfigPayloadSchema, payload, 'PROVIDER_UPDATE_CONFIG');
        registry.updateConfig(
          validated.providerType as ProviderType,
          validated.config
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_UPDATE_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Provider Plugin Handlers
  // ============================================

  // Discover plugins
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_DISCOVER,
    async (): Promise<IpcResponse> => {
      try {
        const plugins = await pluginManager.discoverPlugins();
        return { success: true, data: plugins };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_DISCOVER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Load plugin
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_LOAD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(PluginsLoadPayloadSchema, payload, 'PLUGINS_LOAD');
        const plugin = await pluginManager.loadPlugin(validated.idOrPath, {
          timeout: validated.timeout,
          sandbox: validated.sandbox
        });
        return {
          success: true,
          data: plugin ? pluginManager.pluginToProviderConfig(plugin) : null
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_LOAD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Unload plugin
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_UNLOAD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(PluginsUnloadPayloadSchema, payload, 'PLUGINS_UNLOAD');
        await pluginManager.unloadPlugin(validated.pluginId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_UNLOAD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Install plugin
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_INSTALL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(PluginsInstallPayloadSchema, payload, 'PLUGINS_INSTALL');
        const meta = await pluginManager.installPlugin(validated.sourcePath);
        return { success: true, data: meta };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_INSTALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Uninstall plugin
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_UNINSTALL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(PluginsUninstallPayloadSchema, payload, 'PLUGINS_UNINSTALL');
        await pluginManager.uninstallPlugin(validated.pluginId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_UNINSTALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get a specific plugin
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(PluginsGetPayloadSchema, payload, 'PLUGINS_GET');
        const plugin = pluginManager.getPlugin(validated.pluginId);
        return {
          success: true,
          data: plugin ? pluginManager.pluginToProviderConfig(plugin) : null
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get all loaded plugins
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_GET_ALL,
    async (): Promise<IpcResponse> => {
      try {
        const plugins = pluginManager.getLoadedPlugins();
        return {
          success: true,
          data: plugins.map((p) => pluginManager.pluginToProviderConfig(p))
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_GET_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get plugin metadata
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_GET_META,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(PluginsGetMetaPayloadSchema, payload, 'PLUGINS_GET_META');
        const allMeta = pluginManager.getAllPluginMeta();
        const meta = allMeta.find((m) => m.id === validated.pluginId);
        return { success: true, data: meta || null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_GET_META_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Create plugin template
  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_CREATE_TEMPLATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(PluginsCreateTemplatePayloadSchema, payload, 'PLUGINS_CREATE_TEMPLATE');
        const filePath = pluginManager.savePluginTemplate(validated.name);
        return { success: true, data: { filePath } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLUGINS_CREATE_TEMPLATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Forward plugin events to renderer
  pluginManager.on('plugin-loaded', (pluginId) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.PLUGINS_LOADED, { pluginId });
  });

  pluginManager.on('plugin-unloaded', (pluginId) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.PLUGINS_UNLOADED, { pluginId });
  });

  pluginManager.on('plugin-error', (pluginId, error) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.PLUGINS_ERROR, { pluginId, error: error.message });
  });
}
