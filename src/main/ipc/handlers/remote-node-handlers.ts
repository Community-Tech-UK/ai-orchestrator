import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getWorkerNodeRegistry, getWorkerNodeConnectionServer } from '../../remote-node';
import { getRemoteNodeConfig, updateRemoteNodeConfig } from '../../remote-node/remote-node-config';
import { getDiscoveryService } from '../../remote-node/discovery-service';
import { generateAuthToken } from '../../remote-node/auth-validator';
import { getNodeIdentityStore } from '../../remote-node/node-identity-store';
import {
  RemoteNodeSetTokenPayloadSchema,
  RemoteNodeRevokePayloadSchema,
} from '@contracts/schemas';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import { getLocalIpv4Addresses } from '../../util/network-addresses';

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
    async (_event, payload: { nodeId: string }): Promise<IpcResponse> => {
      try {
        const node = getWorkerNodeRegistry().getNode(payload.nodeId);
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
    async (_event, payload?: { port?: number; host?: string }): Promise<IpcResponse> => {
      try {
        const config = getRemoteNodeConfig();
        const port = payload?.port ?? config.serverPort;
        const host = payload?.host ?? config.serverHost;
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
        updateRemoteNodeConfig({ authToken: token });
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
        updateRemoteNodeConfig({ authToken: validated.token });
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
    IPC_CHANNELS.REMOTE_NODE_REVOKE,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeRevokePayloadSchema.parse(payload);
        const store = getNodeIdentityStore();
        store.remove(validated.nodeId);
        getSettingsManager().set('remoteNodesRegisteredNodes', store.toJson());
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
            connectedCount: server.getConnectedNodeIds().length,
            runningConfig: {
              port: config.serverPort,
              host: config.serverHost,
              namespace: config.namespace,
            },
            localIps: getLocalIpv4Addresses(),
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

  logger.info('Remote node IPC handlers registered');
}
