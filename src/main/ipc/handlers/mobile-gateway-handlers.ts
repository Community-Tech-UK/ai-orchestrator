import { app, ipcMain } from 'electron';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getMobileGatewayServer } from '../../mobile-gateway/mobile-gateway-server';
import { getMobileDeviceRegistry } from '../../mobile-gateway/mobile-device-registry';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getProviderAccountStore } from '../../providers/account-pool/provider-account-store';
import { getRemoteAuthService } from '../../auth/remote-auth';
import { getWorkerNodeRegistry } from '../../remote-node';
import type { MobilePeopleOverview } from '../../../shared/types/mobile-gateway.types';
import { getLogger } from '../../logging/logger';
import { validatedHandler } from '../validated-handler';

const logger = getLogger('MobileGatewayHandlers');

const MobileGatewayRevokeDevicePayloadSchema = z.object({
  deviceId: z.string().min(1).max(200),
});

const MobileGatewayMarkViewedPayloadSchema = z.object({
  instanceId: z.string().min(1).max(200),
});

const MobileGatewayIssuePairingPayloadSchema = z.object({
  profileId: z.string().min(1).max(200).optional(),
}).optional();

const MobileGatewayAddPersonPayloadSchema = z.object({
  name: z.string().min(1).max(200),
});

const MobileGatewayRemovePersonPayloadSchema = z.object({
  profileId: z.string().min(1).max(200),
});

const MobileGatewaySetPersonSessionPayloadSchema = z.object({
  profileId: z.string().min(1).max(200),
  workerNodeId: z.string().min(1).max(200),
  workingDirectory: z.string().min(1).max(1000),
  allowedAccountProfileIds: z.array(z.string().min(1).max(200)).min(1).max(50),
});

/** Worker computers, connected now or paired before, by name. */
function listComputers(): MobilePeopleOverview['computers'] {
  const computers = new Map<string, { id: string; name: string; online: boolean }>();
  for (const session of getRemoteAuthService().listSessions()) {
    computers.set(session.nodeId, { id: session.nodeId, name: session.nodeName, online: false });
  }
  for (const node of getWorkerNodeRegistry().getAllNodes()) {
    computers.set(node.id, { id: node.id, name: node.name, online: node.status === 'connected' });
  }
  return [...computers.values()];
}

/** The Claude and Codex accounts a person's sessions can be limited to. */
function listAccounts(): MobilePeopleOverview['accounts'] {
  return getProviderAccountStore().listProfiles()
    .filter((profile) => profile.enabled && (profile.provider === 'claude' || profile.provider === 'codex'))
    .map((profile) => ({ id: profile.id, provider: profile.provider as 'claude' | 'codex', label: profile.label }));
}

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
        tlsCertPath: settings.get('mobileGatewayTlsCertPath'),
        tlsKeyPath: settings.get('mobileGatewayTlsKeyPath'),
        devCors: !app.isPackaged,
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

  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_ISSUE_PAIRING, validatedHandler(
    IPC_CHANNELS.MOBILE_GATEWAY_ISSUE_PAIRING,
    MobileGatewayIssuePairingPayloadSchema,
    async (payload): Promise<IpcResponse> => {
    try {
      const status = getMobileGatewayServer().getStatus();
      if (!status.running) {
        return fail('MOBILE_GATEWAY_NOT_RUNNING', new Error('Start the mobile gateway before pairing.'));
      }
      // When serving TLS the phone must connect by the cert's DNS name (an IP
      // won't validate against the cert), so prefer the cert hostname.
      const host = status.secure
        ? status.tlsHostname ?? status.tailscaleIp ?? status.host
        : status.tailscaleIp ?? status.host;
      if (!host || host === '0.0.0.0') {
        return fail('MOBILE_GATEWAY_NO_HOST', new Error('No reachable address found — is Tailscale running on this machine?'));
      }
      const credential = getMobileDeviceRegistry().issuePairing(
        payload?.profileId ? { profileId: payload.profileId } : {},
      );
      const connectPayload = {
        v: 1,
        host,
        port: status.port,
        pairingToken: credential.pairingToken,
        ...(status.secure ? { secure: true } : {}),
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
          secure: Boolean(status.secure),
          qrDataUrl,
        },
      };
    } catch (error) {
      return fail('MOBILE_GATEWAY_ISSUE_PAIRING_FAILED', error);
    }
    },
  ));

  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_LIST_DEVICES, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: getMobileDeviceRegistry().listDevices() };
    } catch (error) {
      return fail('MOBILE_GATEWAY_LIST_DEVICES_FAILED', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MOBILE_GATEWAY_REVOKE_DEVICE,
    validatedHandler(
      IPC_CHANNELS.MOBILE_GATEWAY_REVOKE_DEVICE,
      MobileGatewayRevokeDevicePayloadSchema,
      async ({ deviceId }): Promise<IpcResponse> => ({
        success: true,
        data: { revoked: getMobileDeviceRegistry().revokeDevice(deviceId) },
      }),
      { errorCode: 'MOBILE_GATEWAY_REVOKE_DEVICE_FAILED' },
    ),
  );

  ipcMain.handle(IPC_CHANNELS.MOBILE_GATEWAY_LIST_PEOPLE, async (): Promise<IpcResponse> => {
    try {
      const overview: MobilePeopleOverview = {
        members: getMobileDeviceRegistry().listMembers(),
        computers: listComputers(),
        accounts: listAccounts(),
      };
      return { success: true, data: overview };
    } catch (error) {
      return fail('MOBILE_GATEWAY_LIST_PEOPLE_FAILED', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MOBILE_GATEWAY_ADD_PERSON,
    validatedHandler(
      IPC_CHANNELS.MOBILE_GATEWAY_ADD_PERSON,
      MobileGatewayAddPersonPayloadSchema,
      async ({ name }): Promise<IpcResponse> => ({
        success: true,
        data: getMobileDeviceRegistry().addMember(name),
      }),
      { errorCode: 'MOBILE_GATEWAY_ADD_PERSON_FAILED' },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.MOBILE_GATEWAY_REMOVE_PERSON,
    validatedHandler(
      IPC_CHANNELS.MOBILE_GATEWAY_REMOVE_PERSON,
      MobileGatewayRemovePersonPayloadSchema,
      async ({ profileId }): Promise<IpcResponse> => ({
        success: true,
        data: { removed: getMobileDeviceRegistry().removeMember(profileId) },
      }),
      { errorCode: 'MOBILE_GATEWAY_REMOVE_PERSON_FAILED' },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.MOBILE_GATEWAY_SET_PERSON_SESSION,
    validatedHandler(
      IPC_CHANNELS.MOBILE_GATEWAY_SET_PERSON_SESSION,
      MobileGatewaySetPersonSessionPayloadSchema,
      async ({ profileId, workerNodeId, workingDirectory, allowedAccountProfileIds }): Promise<IpcResponse> => {
        if (!listComputers().some((computer) => computer.id === workerNodeId)) {
          throw new Error('That computer is not paired with Harness.');
        }
        const known = new Set(listAccounts().map((account) => account.id));
        if (!allowedAccountProfileIds.every((id) => known.has(id))) {
          throw new Error('Choose only Claude or Codex accounts that are set up and switched on.');
        }
        return {
          success: true,
          data: getMobileDeviceRegistry().setMemberSession(profileId, { workerNodeId, workingDirectory, allowedAccountProfileIds }),
        };
      },
      { errorCode: 'MOBILE_GATEWAY_SET_PERSON_SESSION_FAILED' },
    ),
  );

  // Opening a session on the desktop clears its "finished" item on the phone.
  ipcMain.handle(
    IPC_CHANNELS.MOBILE_GATEWAY_MARK_VIEWED,
    validatedHandler(
      IPC_CHANNELS.MOBILE_GATEWAY_MARK_VIEWED,
      MobileGatewayMarkViewedPayloadSchema,
      async ({ instanceId }): Promise<IpcResponse> => {
        getMobileGatewayServer().markViewedOnDesktop(instanceId);
        return { success: true };
      },
      { errorCode: 'MOBILE_GATEWAY_MARK_VIEWED_FAILED' },
    ),
  );

  logger.info('Mobile gateway IPC handlers registered');
}
