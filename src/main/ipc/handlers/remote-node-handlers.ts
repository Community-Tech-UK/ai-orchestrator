import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getWorkerNodeRegistry, getWorkerNodeConnectionServer } from '../../remote-node';
import { getRemoteNodeConfig } from '../../remote-node/remote-node-config';
import { getLogger } from '../../logging/logger';

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

  logger.info('Remote node IPC handlers registered');
}
