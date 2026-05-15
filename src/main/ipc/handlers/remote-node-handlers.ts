import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getWorkerNodeRegistry, getWorkerNodeConnectionServer } from '../../remote-node';
import { COORDINATOR_TO_NODE } from '../../remote-node/worker-node-rpc';
import { sendServiceRpc } from '../../remote-node/service-rpc-client';
import { getRemoteNodeConfig, updateRemoteNodeConfig } from '../../remote-node/remote-node-config';
import { getDiscoveryService } from '../../remote-node/discovery-service';
import { generateAuthToken } from '../../remote-node/auth-validator';
import {
  RemoteNodeIssuePairingPayloadSchema,
  RemoteNodeRevokePayloadSchema,
  RemoteNodeRevokePairingPayloadSchema,
  RemoteNodeSetTokenPayloadSchema,
  RemoteNodeGetPayloadSchema,
  RemoteNodeStartServerPayloadSchema,
  RemoteNodeServiceActionPayloadSchema,
} from '@contracts/schemas/remote-node';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import { getLocalIpv4Addresses } from '../../util/network-addresses';
import { getRemoteAuthService } from '../../auth/remote-auth';

const logger = getLogger('RemoteNodeHandlers');

export function registerRemoteNodeHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_LIST,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: getWorkerNodeRegistry().getAllNodes(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_GET,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeGetPayloadSchema.parse(payload);
        const node = getWorkerNodeRegistry().getNode(validated.nodeId);
        return {
          success: true,
          data: node ?? null,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_START_SERVER,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeStartServerPayloadSchema.parse(payload);
        const config = getRemoteNodeConfig();
        const port = validated?.port ?? config.serverPort;
        const host = validated?.host ?? config.serverHost;
        await getWorkerNodeConnectionServer().start(port, host);
        getDiscoveryService().publish(port, config.namespace, config.namespace);
        return { success: true, data: { port, host } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_STOP_SERVER,
    async (): Promise<IpcResponse> => {
      try {
        getDiscoveryService().unpublish();
        getWorkerNodeConnectionServer().stop();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_STOP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_REGENERATE_TOKEN,
    async (): Promise<IpcResponse> => {
      try {
        const token = generateAuthToken();
        getSettingsManager().set('remoteNodesEnrollmentToken', token);
        getRemoteAuthService().setManualPairingCredential(token);
        return { success: true, data: { token } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_REGENERATE_TOKEN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_SET_TOKEN,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeSetTokenPayloadSchema.parse(payload);
        getSettingsManager().set('remoteNodesEnrollmentToken', validated.token);
        getRemoteAuthService().setManualPairingCredential(validated.token);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_SET_TOKEN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_ISSUE_PAIRING,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeIssuePairingPayloadSchema.parse(payload ?? {});
        const credential = getRemoteAuthService().issuePairingCredential(validated);
        return {
          success: true,
          data: credential,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_ISSUE_PAIRING_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_LIST_PAIRINGS,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: getRemoteAuthService().listPendingPairings(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_LIST_PAIRINGS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_REVOKE_PAIRING,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeRevokePairingPayloadSchema.parse(payload);
        return {
          success: true,
          data: { revoked: getRemoteAuthService().revokePairingCredential(validated.token) },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_REVOKE_PAIRING_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_REVOKE,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeRevokePayloadSchema.parse(payload);
        getRemoteAuthService().revokeSession(validated.nodeId);
        const server = getWorkerNodeConnectionServer();
        if (server.isNodeConnected(validated.nodeId)) {
          server.disconnectNode(validated.nodeId);
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_REVOKE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_GET_SERVER_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        const server = getWorkerNodeConnectionServer();
        const config = getRemoteNodeConfig();
        return {
          success: true,
          data: {
            running: server.isRunning(),
            connectedCount: server.getConnectedNodeIds().length,
            registeredCount: getRemoteAuthService().listSessions().length,
            pendingPairingCount: getRemoteAuthService().listPendingPairings().length,
            runningConfig: server.isRunning()
              ? {
                  port: config.serverPort,
                  host: config.serverHost,
                  namespace: config.namespace,
                }
              : null,
            localIps: getLocalIpv4Addresses(),
            requireTls: Boolean(config.tlsCertPath && config.tlsKeyPath),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_GET_SERVER_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_SERVICE_STATUS,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeServiceActionPayloadSchema.parse(payload);
        const data = await sendServiceRpc(validated.nodeId, COORDINATOR_TO_NODE.SERVICE_STATUS);
        return { success: true, data };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_SERVICE_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_SERVICE_RESTART,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeServiceActionPayloadSchema.parse(payload);
        await sendServiceRpc(validated.nodeId, COORDINATOR_TO_NODE.SERVICE_RESTART);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_SERVICE_RESTART_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_SERVICE_STOP,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeServiceActionPayloadSchema.parse(payload);
        await sendServiceRpc(validated.nodeId, COORDINATOR_TO_NODE.SERVICE_STOP);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_SERVICE_STOP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_SERVICE_UNINSTALL,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeServiceActionPayloadSchema.parse(payload);
        await sendServiceRpc(validated.nodeId, COORDINATOR_TO_NODE.SERVICE_UNINSTALL);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_SERVICE_UNINSTALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  logger.info('Remote node IPC handlers registered');
}
