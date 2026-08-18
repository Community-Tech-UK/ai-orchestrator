import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

/**
 * Preload bridge for the generic PermissionRegistry approval surface
 * (LT-095): list pending requests, resolve (approve/deny), and extend a
 * short-lived request's deadline. Mirrors the desktop-gateway domain: thin
 * `invoke` wrappers, no push-event channel (the renderer polls, matching the
 * existing browser-approvals banner pattern).
 */
export function createPermissionRegistryDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    permissionRegistryListPending: (payload?: { instanceId?: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PERMISSION_REGISTRY_LIST_PENDING, payload ?? {});
    },
    permissionRegistryResolve: (payload: {
      requestId: string;
      granted: boolean;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PERMISSION_REGISTRY_RESOLVE, payload);
    },
    permissionRegistryExtend: (payload: {
      requestId: string;
      extraMs: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PERMISSION_REGISTRY_EXTEND, payload);
    },
  };
}
