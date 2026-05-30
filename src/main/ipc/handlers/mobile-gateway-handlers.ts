import { ipcMain } from 'electron';
import * as QRCode from 'qrcode';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getMobileGatewayServer } from '../../mobile-gateway/mobile-gateway-server';
import { getMobileDeviceRegistry } from '../../mobile-gateway/mobile-device-registry';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('MobileGatewayHandlers');

function fail(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

export function registerMobileGatewayHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_GET_STATUS, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: getMobileGatewayServer().getStatus() };
    } catch (error) {
      return fail('MOBILE_GATEWAY_GET_STATUS_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_START, async (): Promise<IpcResponse> => {
    try {
      const settings = getSettingsManager();
      settings.set('mobileGatewayEnabled', true);
      const status = await getMobileGatewayServer().start({
        port: settings.get('mobileGatewayPort'),
        bindInterface: settings.get('mobileGatewayBindInterface'),
      });
      return { success: true, data: status };
    } catch (error) {
      return fail('MOBILE_GATEWAY_START_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_STOP, async (): Promise<IpcResponse> => {
    try {
      getSettingsManager().set('mobileGatewayEnabled', false);
      const status = await getMobileGatewayServer().stop();
      return { success: true, data: status };
    } catch (error) {
      return fail('MOBILE_GATEWAY_STOP_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_ISSUE_PAIRING, async (): Promise<IpcResponse> => {
    try {
      const status = getMobileGatewayServer().getStatus();
      if (!status.running) {
        return fail('MOBILE_GATEWAY_NOT_RUNNING', new Error('Start the mobile gateway before pairing.'));
      }
      const host = status.tailscaleIp ?? status.host;
      if (!host || host === '0.0.0.0') {
        return fail('MOBILE_GATEWAY_NO_HOST', new Error('No reachable address found — is Tailscale running on this machine?'));
      }
      const credential = getMobileDeviceRegistry().issuePairing();
      const connectPayload = {
        v: 1,
        host,
        port: status.port,
        pairingToken: credential.pairingToken,
      };
      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(connectPayload), {
        margin: 1,
        width: 320,
      });
      return {
        success: true,
        data: {
          pairingToken: credential.pairingToken,
          expiresAt: credential.expiresAt,
          host,
          port: status.port,
          qrDataUrl,
        },
      };
    } catch (error) {
      return fail('MOBILE_GATEWAY_ISSUE_PAIRING_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_LIST_DEVICES, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: getMobileDeviceRegistry().listDevices() };
    } catch (error) {
      return fail('MOBILE_GATEWAY_LIST_DEVICES_FAILED', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MOBILE_GATEWAY_REVOKE_DEVICE,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const deviceId =
          typeof (payload as { deviceId?: unknown })?.deviceId === 'string'
            ? (payload as { deviceId: string }).deviceId
            : '';
        if (!deviceId) {
          return fail('MOBILE_GATEWAY_REVOKE_DEVICE_FAILED', new Error('deviceId is required'));
        }
        return {
          success: true,
          data: { revoked: getMobileDeviceRegistry().revokeDevice(deviceId) },
        };
      } catch (error) {
        return fail('MOBILE_GATEWAY_REVOKE_DEVICE_FAILED', error);
      }
    },
  );

  logger.info('Mobile gateway IPC handlers registered');
}
