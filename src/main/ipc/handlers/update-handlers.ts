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
import { registerCleanup } from '../../util/cleanup-registry';

let activeCleanup: (() => void) | null = null;

export function registerUpdateHandlers(deps: { windowManager: WindowManager }): () => void {
  activeCleanup?.();
  const service = getAutoUpdateService();

  // Broadcast status transitions to the renderer.
  let acceptingStatus = true;
  const broadcastStatus = (status: unknown) => {
    if (!acceptingStatus) return;
    deps.windowManager.sendToRenderer(IPC_CHANNELS.UPDATE_STATUS_CHANGED, status);
  };
  service.on('status', broadcastStatus);

  // Active only in a packaged app; a missing feed in dev would otherwise throw.
  service.initialize({
    enabled: app.isPackaged,
    autoDownload: true,
    currentVersion: app.getVersion(),
  });

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

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    acceptingStatus = false;
    if (activeCleanup === cleanup) activeCleanup = null;
    service.off('status', broadcastStatus);
    service.dispose();
    ipcMain.removeHandler(IPC_CHANNELS.UPDATE_CHECK);
    ipcMain.removeHandler(IPC_CHANNELS.UPDATE_DOWNLOAD);
    ipcMain.removeHandler(IPC_CHANNELS.UPDATE_INSTALL);
    ipcMain.removeHandler(IPC_CHANNELS.UPDATE_GET_STATUS);
  };
  activeCleanup = cleanup;
  registerCleanup(cleanup);
  return cleanup;
}
