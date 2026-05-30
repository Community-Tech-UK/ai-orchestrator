import { IpcRenderer } from 'electron';
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
  };
}
