import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
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

const NodeIdSchema = z.string().min(1).max(200);
const RemotePathSchema = z.string().min(1).max(4096);
const JobIdSchema = z.string().min(1).max(200);

const RemoteFsCopyToRemotePayloadSchema = z.object({
  nodeId: NodeIdSchema,
  localPath: RemotePathSchema,
  remotePath: RemotePathSchema,
});

const RemoteFsCopyFromRemotePayloadSchema = z.object({
  nodeId: NodeIdSchema,
  remotePath: RemotePathSchema,
  localPath: RemotePathSchema,
});

const RemoteFsReadFilePayloadSchema = z.object({
  nodeId: NodeIdSchema,
  path: RemotePathSchema,
});

const RemoteFsWriteFilePayloadSchema = z.object({
  nodeId: NodeIdSchema,
  path: RemotePathSchema,
  data: z.string().max(50_000_000),
  mkdirp: z.boolean().optional(),
});

const RemoteFsSyncStartPayloadSchema = z.object({
  sourceNodeId: NodeIdSchema,
  sourcePath: RemotePathSchema,
  targetNodeId: NodeIdSchema,
  targetPath: RemotePathSchema,
  deleteExtraneous: z.boolean().optional(),
  exclude: z.array(z.string().max(1024)).max(1000).optional(),
  dryRun: z.boolean().optional(),
  blockSize: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
});

const RemoteFsSyncJobPayloadSchema = z.object({
  jobId: JobIdSchema,
});

const RemoteFsSyncDiffPayloadSchema = z.object({
  sourceNodeId: NodeIdSchema,
  sourcePath: RemotePathSchema,
  targetNodeId: NodeIdSchema,
  targetPath: RemotePathSchema,
  exclude: z.array(z.string().max(1024)).max(1000).optional(),
});

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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsCopyToRemotePayloadSchema.parse(payload);
        const result = await getFileTransferService().copyToRemote(validated);
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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsCopyFromRemotePayloadSchema.parse(payload);
        const result = await getFileTransferService().copyFromRemote(validated);
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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsReadFilePayloadSchema.parse(payload);
        const result = await getFilesystemService().readFile(
          validated.nodeId,
          validated.path
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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsWriteFilePayloadSchema.parse(payload);
        const result = await getFilesystemService().writeFile(
          validated.nodeId,
          validated.path,
          validated.data,
          validated.mkdirp
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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsSyncStartPayloadSchema.parse(payload);
        const jobId = await getDirectorySyncService().startSync(validated);
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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsSyncJobPayloadSchema.parse(payload);
        const progress = getDirectorySyncService().getProgress(validated.jobId);
        if (!progress) {
          return {
            success: false,
            error: {
              code: 'SYNC_JOB_NOT_FOUND',
              message: `No sync job found: ${validated.jobId}`,
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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsSyncJobPayloadSchema.parse(payload);
        const cancelled = getDirectorySyncService().cancelSync(validated.jobId);
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
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = RemoteFsSyncDiffPayloadSchema.parse(payload);
        const diff = await getDirectorySyncService().diffOnly(validated);
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
