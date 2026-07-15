import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

/**
 * Preload bridge for the Harness Computer Use (desktop gateway) diagnostics and
 * management surface consumed by the renderer Settings tab. Mirrors the browser
 * gateway domain: thin `invoke` wrappers plus a change-event subscription.
 */
export function createDesktopDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    desktopGetHealth: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_GET_HEALTH, {});
    },
    desktopListApps: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_LIST_APPS, {});
    },
    desktopListGrants: (payload?: {
      appId?: string;
      includeExpired?: boolean;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_LIST_GRANTS, payload ?? {});
    },
    desktopRevokeGrant: (payload: {
      grantId: string;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_REVOKE_GRANT, payload);
    },
    desktopGetAuditLog: (payload?: {
      appId?: string;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_GET_AUDIT_LOG, payload ?? {});
    },
    desktopRequestSystemPermission: (payload: {
      permission: 'screen-recording' | 'accessibility';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_REQUEST_SYSTEM_PERMISSION, payload);
    },
    desktopRepairSystemPermissions: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_REPAIR_SYSTEM_PERMISSIONS, {});
    },
    desktopRelaunchApplication: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DESKTOP_RELAUNCH_APPLICATION, {});
    },
    onDesktopChanged: (callback: (payload: unknown) => void): (() => void) => {
      const listener = (_event: unknown, payload: unknown): void => callback(payload);
      ipcRenderer.on(ch.DESKTOP_CHANGED, listener);
      return () => ipcRenderer.removeListener(ch.DESKTOP_CHANGED, listener);
    },
  };
}
