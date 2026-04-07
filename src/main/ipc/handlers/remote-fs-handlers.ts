import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getFilesystemService } from '../../services/filesystem-service';
import { getLogger } from '../../logging/logger';
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema,
} from '../../../shared/validation/remote-fs-schemas';

const logger = getLogger('RemoteFsHandlers');

export function registerRemoteFsHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_READ_DIR,
    async (_event: IpcMainInvokeEvent, payload: { nodeId: string; path: string; depth?: number; includeHidden?: boolean }): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsReadDirectoryParamsSchema.parse(rest);
        const result = await getFilesystemService().readDirectory(nodeId, params.path, {
          depth: params.depth,
          includeHidden: params.includeHidden,
        });
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_READ_DIR failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_READ_DIR_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_STAT,
    async (_event: IpcMainInvokeEvent, payload: { nodeId: string; path: string }): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsStatParamsSchema.parse(rest);
        const result = await getFilesystemService().stat(nodeId, params.path);
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_STAT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_STAT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_SEARCH,
    async (_event: IpcMainInvokeEvent, payload: { nodeId: string; query: string; maxResults?: number }): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsSearchParamsSchema.parse(rest);
        const result = await getFilesystemService().search(nodeId, params.query, params.maxResults);
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_SEARCH failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_SEARCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_WATCH,
    async (_event: IpcMainInvokeEvent, payload: { nodeId: string; path: string; recursive?: boolean }): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsWatchParamsSchema.parse(rest);
        const result = await getFilesystemService().watch(nodeId, params.path, params.recursive);
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_WATCH failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_WATCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_UNWATCH,
    async (_event: IpcMainInvokeEvent, payload: { nodeId: string; watchId: string }): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsUnwatchParamsSchema.parse(rest);
        await getFilesystemService().unwatch(nodeId, params.watchId);
        return { success: true };
      } catch (error) {
        logger.error('REMOTE_FS_UNWATCH failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_UNWATCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
