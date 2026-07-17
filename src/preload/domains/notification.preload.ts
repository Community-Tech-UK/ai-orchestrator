import { IpcRenderer, IpcRendererEvent } from 'electron';
import type { NotificationRecord } from '../../shared/types/notification.types';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createNotificationDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    notificationList: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.NOTIFICATION_LIST),
    notificationDismiss: (id: string): Promise<IpcResponse> => ipcRenderer.invoke(ch.NOTIFICATION_DISMISS, { id }),
    notificationClear: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.NOTIFICATION_CLEAR),
    onNotificationDelta: (callback: (record: NotificationRecord) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, record: NotificationRecord) => callback(record);
      ipcRenderer.on(ch.NOTIFICATION_DELTA, listener);
      return () => ipcRenderer.removeListener(ch.NOTIFICATION_DELTA, listener);
    },
  };
}
