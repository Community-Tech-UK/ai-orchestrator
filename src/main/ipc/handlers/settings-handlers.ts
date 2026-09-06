/**
 * Settings IPC Handlers
 * Handles settings, config, and remote config related IPC communication
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  ConfigCreateProjectPayloadSchema,
  ConfigFindProjectPayloadSchema,
  ConfigGetProjectPayloadSchema,
  ConfigResolvePayloadSchema,
  ConfigSaveProjectPayloadSchema,
  SettingsBulkUpdatePayloadSchema,
  SettingsGetPayloadSchema,
  SettingsResetOnePayloadSchema,
  SettingsUpdatePayloadSchema,
} from '@contracts/schemas/settings';
import type { AppSettings, ProjectConfig } from '../../../shared/types/settings.types';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getRemoteConfigManager } from '../../core/config/remote-config';
import {
  coerceRendererSettingValue,
  coerceRendererSettingsUpdate,
  requireKnownSettingsToolKey,
} from '../../core/config/settings-control-policy';
import { WindowManager } from '../../window-manager';
import { broadcastSettingsChanged } from './settings-broadcast';
import { registerSettingsRemoteConfigHandlers } from './settings-remote-config-handlers';
import { registerSettingsTransferHandlers } from './settings-transfer-handlers';

interface SettingsHandlerDeps {
  windowManager: WindowManager;
}

export function registerSettingsHandlers(deps: SettingsHandlerDeps): void {
  const settings = getSettingsManager();

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
          data: settings.get(requireKnownSettingsToolKey(validated.key))
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

        const { key, value } = coerceRendererSettingValue(
          validatedPayload.key,
          validatedPayload.value,
        );
        settings.set(key, value);
        const persistedValue = settings.get(key);
        broadcastSettingsChanged(deps.windowManager, {
            key,
            value: persistedValue
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
        const coercedSettings = coerceRendererSettingsUpdate(
          settingsData as Record<string, unknown>,
        );

        settings.update(coercedSettings);
        broadcastSettingsChanged(deps.windowManager, {
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
        broadcastSettingsChanged(deps.windowManager, {
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
        const resetKey = requireKnownSettingsToolKey(validated.key);
        settings.resetOne(resetKey);
        const value = settings.get(resetKey);
        broadcastSettingsChanged(deps.windowManager, {
            key: resetKey,
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

  registerSettingsRemoteConfigHandlers(deps);
  registerSettingsTransferHandlers(deps);
}
