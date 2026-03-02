/**
 * Recent Directories IPC Handlers
 * Handles operations for recently opened directories
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getRecentDirectoriesManager } from '../../core/config/recent-directories-manager';
import {
  validateIpcPayload,
  RecentDirsGetPayloadSchema,
  RecentDirsAddPayloadSchema,
  RecentDirsRemovePayloadSchema,
  RecentDirsPinPayloadSchema,
  RecentDirsClearPayloadSchema,
} from '../../../shared/validation/ipc-schemas';
import { getSettingsManager } from '../../core/config/settings-manager';

export function registerRecentDirectoriesHandlers(): void {
  const manager = getRecentDirectoriesManager();

  // Initialize from settings
  try {
    const settings = getSettingsManager();

    // Apply max entries from settings
    const maxEntries = settings.get('maxRecentDirectories');
    if (maxEntries && maxEntries > 0) {
      manager.setMaxEntries(maxEntries);
    }

    // Seed with default working directory (one-time migration)
    const defaultDir = settings.get('defaultWorkingDirectory');
    if (defaultDir) {
      manager.seedFromDefaultDirectory(defaultDir);
    }

    // Listen for settings changes to update max entries
    settings.on('change', (key: string, value: unknown) => {
      if (key === 'maxRecentDirectories' && typeof value === 'number') {
        manager.setMaxEntries(value);
      }
    });
  } catch (error) {
    console.warn('[RecentDirectories] Failed to initialize from settings:', error);
  }

  // Get recent directories
  ipcMain.handle(
    IPC_CHANNELS.RECENT_DIRS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RecentDirsGetPayloadSchema, payload, 'RECENT_DIRS_GET');
        const entries = manager.getDirectories({
          limit: validated?.limit,
          sortBy: validated?.sortBy,
          includePinned: validated?.includePinned
        });

        return {
          success: true,
          data: entries
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RECENT_DIRS_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Add a directory to recent list
  ipcMain.handle(
    IPC_CHANNELS.RECENT_DIRS_ADD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RecentDirsAddPayloadSchema, payload, 'RECENT_DIRS_ADD');
        const entry = manager.addDirectory(validated.path);

        return {
          success: true,
          data: entry
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RECENT_DIRS_ADD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Remove a directory from recent list
  ipcMain.handle(
    IPC_CHANNELS.RECENT_DIRS_REMOVE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RecentDirsRemovePayloadSchema, payload, 'RECENT_DIRS_REMOVE');
        const removed = manager.removeDirectory(validated.path);

        return {
          success: true,
          data: { removed }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RECENT_DIRS_REMOVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Pin or unpin a directory
  ipcMain.handle(
    IPC_CHANNELS.RECENT_DIRS_PIN,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RecentDirsPinPayloadSchema, payload, 'RECENT_DIRS_PIN');
        const pinned = manager.pinDirectory(validated.path, validated.pinned);

        return {
          success: true,
          data: { pinned }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RECENT_DIRS_PIN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear all recent directories
  ipcMain.handle(
    IPC_CHANNELS.RECENT_DIRS_CLEAR,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RecentDirsClearPayloadSchema, payload, 'RECENT_DIRS_CLEAR');
        manager.clearAll(validated?.keepPinned !== false);

        return {
          success: true,
          data: null
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RECENT_DIRS_CLEAR_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
