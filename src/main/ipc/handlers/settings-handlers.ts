/**
 * Settings IPC Handlers
 * Handles settings, config, and remote config related IPC communication
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  SettingsGetPayloadSchema,
  SettingsUpdatePayloadSchema,
  SettingsBulkUpdatePayloadSchema,
  SettingsResetOnePayloadSchema,
  ConfigResolvePayloadSchema,
  ConfigGetProjectPayloadSchema,
  ConfigSaveProjectPayloadSchema,
  ConfigCreateProjectPayloadSchema,
  ConfigFindProjectPayloadSchema,
  RemoteConfigFetchUrlPayloadSchema,
  RemoteConfigFetchWellKnownPayloadSchema,
  RemoteConfigFetchGitHubPayloadSchema,
  RemoteConfigDiscoverGitPayloadSchema,
  RemoteConfigInvalidatePayloadSchema,
  validateIpcPayload
} from '@contracts/schemas';
import type { AppSettings, ProjectConfig } from '../../../shared/types/settings.types';
import { getSettingsManager } from '../../core/config/settings-manager';
import { exportSettings, importSettings } from '../../core/config/settings-export';
import {
  resolveConfig,
  loadProjectConfig,
  saveProjectConfig,
  createProjectConfig,
  findProjectConfigPath
} from '../../core/config/config-resolver';
import { getRemoteConfigManager } from '../../core/config/remote-config';
import { WindowManager } from '../../window-manager';

interface SettingsHandlerDeps {
  windowManager: WindowManager;
}

export function registerSettingsHandlers(deps: SettingsHandlerDeps): void {
  const settings = getSettingsManager();
  const remoteConfigManager = getRemoteConfigManager();

  // ============================================
  // Settings Handlers
  // ============================================

  // Get all settings
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET_ALL,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: settings.getAll()
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_GET_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get single setting
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          SettingsGetPayloadSchema,
          payload,
          'SETTINGS_GET'
        );
        return {
          success: true,
          data: settings.get(validated.key as keyof AppSettings)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Set single setting
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          SettingsUpdatePayloadSchema,
          payload,
          'SETTINGS_SET'
        );

        settings.set(validatedPayload.key as keyof AppSettings, validatedPayload.value as any);
        // Notify renderer of change
        deps.windowManager
          .getMainWindow()
          ?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            key: validatedPayload.key,
            value: validatedPayload.value
          });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_SET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update multiple settings
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_UPDATE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          SettingsBulkUpdatePayloadSchema,
          payload,
          'SETTINGS_UPDATE'
        );

        // If payload has a 'settings' key, use that; otherwise treat payload as settings
        const settingsData = validated.settings || validated;

        settings.update(settingsData as Partial<AppSettings>);
        // Notify renderer of changes
        deps.windowManager
          .getMainWindow()
          ?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            settings: settings.getAll()
          });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_UPDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Reset all settings
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_RESET,
    async (): Promise<IpcResponse> => {
      try {
        settings.reset();
        // Notify renderer
        deps.windowManager
          .getMainWindow()
          ?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            settings: settings.getAll()
          });
        return {
          success: true,
          data: settings.getAll()
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_RESET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Reset single setting
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_RESET_ONE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          SettingsResetOnePayloadSchema,
          payload,
          'SETTINGS_RESET_ONE'
        );
        settings.resetOne(validated.key as keyof AppSettings);
        const value = settings.get(validated.key as keyof AppSettings);
        // Notify renderer
        deps.windowManager
          .getMainWindow()
          ?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            key: validated.key,
            value
          });
        return {
          success: true,
          data: value
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_RESET_ONE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Config Handlers
  // ============================================

  // Resolve configuration for a working directory
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_RESOLVE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ConfigResolvePayloadSchema,
          payload,
          'CONFIG_RESOLVE'
        );
        const resolved = resolveConfig(validated.workingDirectory);
        return {
          success: true,
          data: resolved
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CONFIG_RESOLVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get project config from a specific path
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_GET_PROJECT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ConfigGetProjectPayloadSchema,
          payload,
          'CONFIG_GET_PROJECT'
        );
        const config = loadProjectConfig(validated.configPath);
        if (!config) {
          return {
            success: false,
            error: {
              code: 'CONFIG_NOT_FOUND',
              message: `Project config not found at ${validated.configPath}`,
              timestamp: Date.now()
            }
          };
        }
        return {
          success: true,
          data: config
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CONFIG_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Save project config
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SAVE_PROJECT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ConfigSaveProjectPayloadSchema,
          payload,
          'CONFIG_SAVE_PROJECT'
        );
        const saved = saveProjectConfig(
          validated.configPath,
          validated.config as ProjectConfig
        );
        return {
          success: saved,
          error: saved
            ? undefined
            : {
                code: 'CONFIG_SAVE_FAILED',
                message: `Failed to save project config to ${validated.configPath}`,
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CONFIG_SAVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Create new project config
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_CREATE_PROJECT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ConfigCreateProjectPayloadSchema,
          payload,
          'CONFIG_CREATE_PROJECT'
        );
        const configPath = createProjectConfig(
          validated.projectDir,
          validated.config as Partial<ProjectConfig>
        );
        return {
          success: true,
          data: { configPath }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CONFIG_CREATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Find project config path
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_FIND_PROJECT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ConfigFindProjectPayloadSchema,
          payload,
          'CONFIG_FIND_PROJECT'
        );
        const configPath = findProjectConfigPath(validated.startDir);
        return {
          success: true,
          data: { configPath }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CONFIG_FIND_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Remote Config Handlers
  // ============================================

  // Fetch config from URL
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_FETCH_URL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigFetchUrlPayloadSchema,
          payload,
          'REMOTE_CONFIG_FETCH_URL'
        );
        const config = await remoteConfigManager.fetchFromUrl(validated.url, {
          timeout: validated.timeout,
          cacheTTL: validated.cacheTTL,
          maxRetries: validated.maxRetries,
          useCache: validated.useCache
        });
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_FETCH_URL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Fetch from well-known endpoint
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_FETCH_WELL_KNOWN,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigFetchWellKnownPayloadSchema,
          payload,
          'REMOTE_CONFIG_FETCH_WELL_KNOWN'
        );
        const config = await remoteConfigManager.fetchFromWellKnown(
          validated.domain,
          {
            timeout: validated.timeout,
            cacheTTL: validated.cacheTTL
          }
        );
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_FETCH_WELL_KNOWN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Fetch from GitHub
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_FETCH_GITHUB,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigFetchGitHubPayloadSchema,
          payload,
          'REMOTE_CONFIG_FETCH_GITHUB'
        );
        const config = await remoteConfigManager.fetchFromGitHub(
          validated.owner,
          validated.repo,
          validated.branch
        );
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_FETCH_GITHUB_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Discover config for git repo
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_DISCOVER_GIT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigDiscoverGitPayloadSchema,
          payload,
          'REMOTE_CONFIG_DISCOVER_GIT'
        );
        const config = await remoteConfigManager.discoverForGitRepo(
          validated.gitRemoteUrl
        );
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_DISCOVER_GIT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get cached configs
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_GET_CACHED,
    async (): Promise<IpcResponse> => {
      try {
        const cached = remoteConfigManager.getCachedConfigs();
        return { success: true, data: cached };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_GET_CACHED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear cache
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_CLEAR_CACHE,
    async (): Promise<IpcResponse> => {
      try {
        remoteConfigManager.clearCache();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_CLEAR_CACHE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Invalidate specific cache entry
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_INVALIDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigInvalidatePayloadSchema,
          payload,
          'REMOTE_CONFIG_INVALIDATE'
        );
        remoteConfigManager.invalidateCache(validated.url);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_INVALIDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Settings Export/Import
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_EXPORT,
    async (): Promise<IpcResponse> => {
      try {
        const filePath = await exportSettings();
        if (!filePath) {
          return { success: true, data: { cancelled: true } };
        }
        return { success: true, data: { filePath } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_EXPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_IMPORT,
    async (): Promise<IpcResponse> => {
      try {
        const result = await importSettings();
        if (!result) {
          return { success: true, data: { cancelled: true } };
        }
        // Notify renderer that settings changed so stores reload
        deps.windowManager
          .getMainWindow()
          ?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            key: '__imported__',
            value: null,
          });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_IMPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );
}
