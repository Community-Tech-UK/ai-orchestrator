/**
 * Auto-update IPC handlers (backlog #24).
 *
 * Wires the AutoUpdateService to the renderer:
 *   - update:check / update:download / update:install / update:get-status
 *   - update:status-changed (push) — broadcast on every status transition
 *
 * The service is initialized here with enabled = app.isPackaged, so auto-update
 * is inert in dev and active only in a packaged build.
 */

import { app, ipcMain } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getAutoUpdateService } from '../../updates/auto-update-service';
import type { WindowManager } from '../../window-manager';

export function registerUpdateHandlers(deps: { windowManager: WindowManager }): void {
  const service = getAutoUpdateService();

  // Broadcast status transitions to the renderer.
  service.on('status', (status) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.UPDATE_STATUS_CHANGED, status);
  });

  // Active only in a packaged app; a missing feed in dev would otherwise throw.
  service.initialize({ enabled: app.isPackaged, autoDownload: false });

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async (): Promise<IpcResponse> => {
    return { success: true, data: await service.checkForUpdates() };
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async (): Promise<IpcResponse> => {
    return { success: true, data: await service.downloadUpdate() };
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, async (): Promise<IpcResponse> => {
    return { success: true, data: { installing: service.quitAndInstall() } };
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATUS, async (): Promise<IpcResponse> => {
    return { success: true, data: service.getStatus() };
  });
}
