/**
 * Snapshot IPC Handlers
 * Handles snapshot-related IPC communication from renderer
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  validateIpcPayload,
  SnapshotTakePayloadSchema,
  SnapshotStartSessionPayloadSchema,
  SnapshotEndSessionPayloadSchema,
  SnapshotGetForInstancePayloadSchema,
  SnapshotGetForFilePayloadSchema,
  SnapshotGetSessionsPayloadSchema,
  SnapshotGetContentPayloadSchema,
  SnapshotRevertFilePayloadSchema,
  SnapshotRevertSessionPayloadSchema,
  SnapshotGetDiffPayloadSchema,
  SnapshotDeletePayloadSchema,
  SnapshotCleanupPayloadSchema,
} from '@contracts/schemas';
import { getSnapshotManager } from '../../persistence/snapshot-manager';

export function registerSnapshotHandlers(): void {
  const snapshots = getSnapshotManager();

  // Take a snapshot
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_TAKE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotTakePayloadSchema, payload, 'SNAPSHOT_TAKE');
        const snapshotId = snapshots.takeSnapshot(
          validated.filePath,
          validated.instanceId,
          validated.sessionId,
          validated.action
        );
        return {
          success: true,
          data: { snapshotId }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_TAKE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Start a session
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_START_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotStartSessionPayloadSchema, payload, 'SNAPSHOT_START_SESSION');
        const sessionId = snapshots.startSession(
          validated.instanceId,
          validated.description
        );
        return {
          success: true,
          data: { sessionId }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_START_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // End a session
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_END_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotEndSessionPayloadSchema, payload, 'SNAPSHOT_END_SESSION');
        const session = snapshots.endSession(validated.sessionId);
        return {
          success: true,
          data: session
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_END_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get snapshots for instance
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_GET_FOR_INSTANCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotGetForInstancePayloadSchema, payload, 'SNAPSHOT_GET_FOR_INSTANCE');
        const snapshotList = snapshots.getSnapshotsForInstance(
          validated.instanceId
        );
        return {
          success: true,
          data: snapshotList
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_GET_FOR_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get snapshots for file
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_GET_FOR_FILE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotGetForFilePayloadSchema, payload, 'SNAPSHOT_GET_FOR_FILE');
        const snapshotList = snapshots.getSnapshotsForFile(validated.filePath);
        return {
          success: true,
          data: snapshotList
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_GET_FOR_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get sessions for instance
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_GET_SESSIONS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotGetSessionsPayloadSchema, payload, 'SNAPSHOT_GET_SESSIONS');
        const sessions = snapshots.getSessionsForInstance(validated.instanceId);
        return {
          success: true,
          data: sessions
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_GET_SESSIONS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get snapshot content
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_GET_CONTENT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotGetContentPayloadSchema, payload, 'SNAPSHOT_GET_CONTENT');
        const content = snapshots.getSnapshotContent(validated.snapshotId);
        return {
          success: true,
          data: { content }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_GET_CONTENT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Revert a file
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_REVERT_FILE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotRevertFilePayloadSchema, payload, 'SNAPSHOT_REVERT_FILE');
        const result = snapshots.revertFile(validated.snapshotId);
        return {
          success: result.success,
          data: result,
          error: result.success
            ? undefined
            : {
                code: 'SNAPSHOT_REVERT_FAILED',
                message: result.errors.map((e) => e.error).join(', '),
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_REVERT_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Revert a session
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_REVERT_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotRevertSessionPayloadSchema, payload, 'SNAPSHOT_REVERT_SESSION');
        const result = snapshots.revertSession(validated.sessionId);
        return {
          success: result.success,
          data: result,
          error: result.success
            ? undefined
            : {
                code: 'SNAPSHOT_REVERT_SESSION_FAILED',
                message: result.errors.map((e) => e.error).join(', '),
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_REVERT_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get diff between snapshot and current
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_GET_DIFF,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotGetDiffPayloadSchema, payload, 'SNAPSHOT_GET_DIFF');
        const diff = snapshots.getSnapshotDiff(validated.snapshotId);
        return {
          success: true,
          data: diff
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_GET_DIFF_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Delete a snapshot
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotDeletePayloadSchema, payload, 'SNAPSHOT_DELETE');
        const deleted = snapshots.deleteSnapshot(validated.snapshotId);
        return {
          success: deleted,
          error: deleted
            ? undefined
            : {
                code: 'SNAPSHOT_NOT_FOUND',
                message: `Snapshot ${validated.snapshotId} not found`,
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Cleanup old snapshots
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_CLEANUP,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SnapshotCleanupPayloadSchema, payload, 'SNAPSHOT_CLEANUP');
        const deletedCount = snapshots.cleanupOldSnapshots(
          validated.maxAgeDays
        );
        return {
          success: true,
          data: { deletedCount }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_CLEANUP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get stats
  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_GET_STATS,
    async (): Promise<IpcResponse> => {
      try {
        const stats = snapshots.getStats();
        return {
          success: true,
          data: stats
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SNAPSHOT_GET_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
