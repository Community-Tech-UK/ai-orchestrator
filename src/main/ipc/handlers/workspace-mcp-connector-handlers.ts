import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  WorkspaceMcpConnectorDeleteSchema,
  WorkspaceMcpConnectorListSchema,
  WorkspaceMcpConnectorUpsertSchema,
} from '@contracts/schemas/mcp-multi-provider';
import { getWorkspaceMcpConnectorService } from '../../mcp/mcp-multi-provider-singletons';
import { getLogger } from '../../logging/logger';

const logger = getLogger('WorkspaceMcpConnectorHandlers');

export function registerWorkspaceMcpConnectorHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.MCP_WORKSPACE_CONNECTOR_LIST,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          WorkspaceMcpConnectorListSchema,
          payload,
          'MCP_WORKSPACE_CONNECTOR_LIST',
        );
        const data = getWorkspaceMcpConnectorService().list(
          validated.workingDirectory,
          validated.provider,
        );
        return { success: true, data };
      } catch (error) {
        logger.warn('Workspace MCP connector list failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: {
            code: 'MCP_WORKSPACE_CONNECTOR_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_WORKSPACE_CONNECTOR_UPSERT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          WorkspaceMcpConnectorUpsertSchema,
          payload,
          'MCP_WORKSPACE_CONNECTOR_UPSERT',
        );
        const data = getWorkspaceMcpConnectorService().upsert(validated);
        return { success: true, data };
      } catch (error) {
        logger.warn('Workspace MCP connector upsert failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: {
            code: 'MCP_WORKSPACE_CONNECTOR_UPSERT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_WORKSPACE_CONNECTOR_DELETE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          WorkspaceMcpConnectorDeleteSchema,
          payload,
          'MCP_WORKSPACE_CONNECTOR_DELETE',
        );
        getWorkspaceMcpConnectorService().delete(validated.id);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_WORKSPACE_CONNECTOR_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
