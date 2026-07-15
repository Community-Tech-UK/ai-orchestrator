import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import type { WindowManager } from '../../window-manager';
import { getNotificationService, type NotificationService } from '../../notifications/notification-service';
import { registerCleanup } from '../../util/cleanup-registry';
import type { IpcResponse } from '../validated-handler';

interface NotificationHandlerDependencies {
  windowManager: WindowManager;
  notificationService?: NotificationService;
}

let activeCleanup: (() => void) | null = null;

export function registerNotificationHandlers(dependencies: NotificationHandlerDependencies): () => void {
  activeCleanup?.();
  const notificationService = dependencies.notificationService ?? getNotificationService();
  let acceptingDeltas = true;
  const unsubscribe = notificationService.subscribe((record) => {
    if (!acceptingDeltas) return;
    dependencies.windowManager.sendToRenderer(IPC_CHANNELS.NOTIFICATION_DELTA, record);
  });

  ipcMain.handle(
    IPC_CHANNELS.NOTIFICATION_LIST,
    async (): Promise<IpcResponse> => ({ success: true, data: notificationService.list() }),
  );

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    acceptingDeltas = false;
    if (activeCleanup === cleanup) activeCleanup = null;
    unsubscribe();
    ipcMain.removeHandler(IPC_CHANNELS.NOTIFICATION_LIST);
  };
  activeCleanup = cleanup;
  registerCleanup(cleanup);
  return cleanup;
}
