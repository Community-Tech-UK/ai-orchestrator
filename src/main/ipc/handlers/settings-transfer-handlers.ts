import { ipcMain } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { exportSettings, importSettings } from '../../core/config/settings-export';
import { WindowManager } from '../../window-manager';
import { broadcastSettingsChanged } from './settings-broadcast';

interface SettingsTransferHandlerDeps {
  windowManager: WindowManager;
}

export function registerSettingsTransferHandlers(
  deps: SettingsTransferHandlerDeps,
): void {
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
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_IMPORT,
    async (): Promise<IpcResponse> => {
      try {
        const result = await importSettings();
        if (!result) {
          return { success: true, data: { cancelled: true } };
        }
        broadcastSettingsChanged(deps.windowManager, {
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
    },
  );
}
