import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getFilesystemService } from '../../services/filesystem-service';
import { getFileTransferService } from '../../remote-node/file-transfer-service';
import { getDirectorySyncService } from '../../remote-node/directory-sync-service';
import { getLogger } from '../../logging/logger';
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema
} from '../../../shared/validation/remote-fs-schemas';

const logger = getLogger('RemoteFsHandlers');

export function registerRemoteFsHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_READ_DIR,
    async (
      _event: IpcMainInvokeEvent,
      payload: {
        nodeId: string;
        path: string;
        depth?: number;
        includeHidden?: boolean;
      }
    ): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsReadDirectoryParamsSchema.parse(rest);
        const result = await getFilesystemService().readDirectory(
          nodeId,
          params.path,
          {
            depth: params.depth,
            includeHidden: params.includeHidden
          }
        );
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_READ_DIR failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_READ_DIR_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_STAT,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; path: string }
    ): Promise<IpcResponse> => {
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
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_SEARCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; query: string; maxResults?: number }
    ): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsSearchParamsSchema.parse(rest);
        const result = await getFilesystemService().search(
          nodeId,
          params.query,
          params.maxResults
        );
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_SEARCH failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_SEARCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_WATCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; path: string; recursive?: boolean }
    ): Promise<IpcResponse> => {
      try {
        const { nodeId, ...rest } = payload;
        const params = FsWatchParamsSchema.parse(rest);
        const result = await getFilesystemService().watch(
          nodeId,
          params.path,
          params.recursive
        );
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_WATCH failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_WATCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_UNWATCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; watchId: string }
    ): Promise<IpcResponse> => {
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
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // -- File transfer handlers ------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_COPY_TO_REMOTE,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; localPath: string; remotePath: string }
    ): Promise<IpcResponse> => {
      try {
        const result = await getFileTransferService().copyToRemote({
          nodeId: payload.nodeId,
          localPath: payload.localPath,
          remotePath: payload.remotePath
        });
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_COPY_TO_REMOTE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_COPY_TO_REMOTE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_COPY_FROM_REMOTE,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; remotePath: string; localPath: string }
    ): Promise<IpcResponse> => {
      try {
        const result = await getFileTransferService().copyFromRemote({
          nodeId: payload.nodeId,
          remotePath: payload.remotePath,
          localPath: payload.localPath
        });
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_COPY_FROM_REMOTE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_COPY_FROM_REMOTE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_READ_FILE,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; path: string }
    ): Promise<IpcResponse> => {
      try {
        const result = await getFilesystemService().readFile(
          payload.nodeId,
          payload.path
        );
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_READ_FILE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_READ_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_WRITE_FILE,
    async (
      _event: IpcMainInvokeEvent,
      payload: { nodeId: string; path: string; data: string; mkdirp?: boolean }
    ): Promise<IpcResponse> => {
      try {
        const { nodeId, ...params } = payload;
        const result = await getFilesystemService().writeFile(
          nodeId,
          params.path,
          params.data,
          params.mkdirp
        );
        return { success: true, data: result };
      } catch (error) {
        logger.error('REMOTE_FS_WRITE_FILE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_WRITE_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // -- Directory sync handlers -----------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_SYNC_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: {
        sourceNodeId: string;
        sourcePath: string;
        targetNodeId: string;
        targetPath: string;
        deleteExtraneous?: boolean;
        exclude?: string[];
        dryRun?: boolean;
        blockSize?: number;
      }
    ): Promise<IpcResponse> => {
      try {
        const jobId = await getDirectorySyncService().startSync(payload);
        return { success: true, data: { jobId } };
      } catch (error) {
        logger.error('REMOTE_FS_SYNC_START failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_SYNC_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_SYNC_PROGRESS,
    async (
      _event: IpcMainInvokeEvent,
      payload: { jobId: string }
    ): Promise<IpcResponse> => {
      try {
        const progress = getDirectorySyncService().getProgress(payload.jobId);
        if (!progress) {
          return {
            success: false,
            error: {
              code: 'SYNC_JOB_NOT_FOUND',
              message: `No sync job found: ${payload.jobId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: progress };
      } catch (error) {
        logger.error('REMOTE_FS_SYNC_PROGRESS failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_SYNC_PROGRESS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_SYNC_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: { jobId: string }
    ): Promise<IpcResponse> => {
      try {
        const cancelled = getDirectorySyncService().cancelSync(payload.jobId);
        return { success: true, data: { cancelled } };
      } catch (error) {
        logger.error('REMOTE_FS_SYNC_CANCEL failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_SYNC_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_SYNC_DIFF,
    async (
      _event: IpcMainInvokeEvent,
      payload: {
        sourceNodeId: string;
        sourcePath: string;
        targetNodeId: string;
        targetPath: string;
        exclude?: string[];
      }
    ): Promise<IpcResponse> => {
      try {
        const diff = await getDirectorySyncService().diffOnly(payload);
        return { success: true, data: diff };
      } catch (error) {
        logger.error('REMOTE_FS_SYNC_DIFF failed', error as Error);
        return {
          success: false,
          error: {
            code: 'REMOTE_FS_SYNC_DIFF_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
