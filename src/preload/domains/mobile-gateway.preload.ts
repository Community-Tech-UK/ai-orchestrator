import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createMobileGatewayDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    mobileGatewayGetStatus: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MOBILE_GATEWAY_GET_STATUS),

    mobileGatewayStart: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.MOBILE_GATEWAY_START),

    mobileGatewayStop: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.MOBILE_GATEWAY_STOP),

    mobileGatewayIssuePairing: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MOBILE_GATEWAY_ISSUE_PAIRING),

    mobileGatewayListDevices: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MOBILE_GATEWAY_LIST_DEVICES),

    mobileGatewayRevokeDevice: (payload: { deviceId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MOBILE_GATEWAY_REVOKE_DEVICE, payload),

    mobileGatewayMarkViewed: (payload: { instanceId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.MOBILE_GATEWAY_MARK_VIEWED, payload),

    onMobileGatewayCompletionViewed: (callback: (data: { instanceId: string }) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: { instanceId: string }) => callback(data);
      ipcRenderer.on(ch.MOBILE_GATEWAY_COMPLETION_VIEWED, listener);
      return () => ipcRenderer.removeListener(ch.MOBILE_GATEWAY_COMPLETION_VIEWED, listener);
    },
  };
}
