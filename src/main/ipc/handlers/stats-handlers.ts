/**
 * Stats IPC Handlers
 * Handles usage statistics tracking and retrieval
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getUsageStatsManager } from '../../core/system/usage-stats';
import {
  validateIpcPayload,
  StatsRecordSessionStartPayloadSchema,
  StatsRecordSessionEndPayloadSchema,
  StatsRecordMessagePayloadSchema,
  StatsRecordToolUsagePayloadSchema,
  StatsGetPayloadSchema,
  StatsGetSessionPayloadSchema,
  StatsExportPayloadSchema,
} from '@contracts/schemas';

export function registerStatsHandlers(): void {
  const statsManager = getUsageStatsManager();

  // Record session start
  ipcMain.handle(
    IPC_CHANNELS.STATS_RECORD_SESSION_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(StatsRecordSessionStartPayloadSchema, payload, 'STATS_RECORD_SESSION_START');
        statsManager.recordSessionStart(
          validated.sessionId,
          validated.instanceId,
          validated.agentId ?? '',
          validated.workingDirectory
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_RECORD_SESSION_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Record session end
  ipcMain.handle(
    IPC_CHANNELS.STATS_RECORD_SESSION_END,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(StatsRecordSessionEndPayloadSchema, payload, 'STATS_RECORD_SESSION_END');
        statsManager.recordSessionEnd(validated.sessionId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_RECORD_SESSION_END_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Record message
  ipcMain.handle(
    IPC_CHANNELS.STATS_RECORD_MESSAGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(StatsRecordMessagePayloadSchema, payload, 'STATS_RECORD_MESSAGE');
        statsManager.recordMessage(
          validated.sessionId,
          validated.inputTokens ?? 0,
          validated.outputTokens ?? 0,
          validated.cost ?? 0
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_RECORD_MESSAGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Record tool usage
  ipcMain.handle(
    IPC_CHANNELS.STATS_RECORD_TOOL_USAGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(StatsRecordToolUsagePayloadSchema, payload, 'STATS_RECORD_TOOL_USAGE');
        statsManager.recordToolUsage(validated.sessionId, validated.tool);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_RECORD_TOOL_USAGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get stats
  ipcMain.handle(
    IPC_CHANNELS.STATS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(StatsGetPayloadSchema, payload, 'STATS_GET');
        const stats = statsManager.getStats(validated?.period ?? 'all');
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get session stats
  ipcMain.handle(
    IPC_CHANNELS.STATS_GET_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(StatsGetSessionPayloadSchema, payload, 'STATS_GET_SESSION');
        const stats = statsManager.getSessionStats(validated.sessionId);
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_GET_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get active sessions
  ipcMain.handle(
    IPC_CHANNELS.STATS_GET_ACTIVE_SESSIONS,
    async (): Promise<IpcResponse> => {
      try {
        const sessions = statsManager.getActiveSessions();
        return { success: true, data: sessions };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_GET_ACTIVE_SESSIONS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get tool usage
  ipcMain.handle(
    IPC_CHANNELS.STATS_GET_TOOL_USAGE,
    async (): Promise<IpcResponse> => {
      try {
        const usage = statsManager.getToolUsage();
        return { success: true, data: usage };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_GET_TOOL_USAGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Export stats
  ipcMain.handle(
    IPC_CHANNELS.STATS_EXPORT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(StatsExportPayloadSchema, payload, 'STATS_EXPORT');
        statsManager.exportStats(validated.filePath, validated.period);
        return { success: true, data: { exportPath: validated.filePath } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_EXPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear stats
  ipcMain.handle(IPC_CHANNELS.STATS_CLEAR, async (): Promise<IpcResponse> => {
    try {
      statsManager.clearStats();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STATS_CLEAR_FAILED',
          message: (error as Error).message,
          timestamp: Date.now()
        }
      };
    }
  });

  // Get storage usage
  ipcMain.handle(
    IPC_CHANNELS.STATS_GET_STORAGE,
    async (): Promise<IpcResponse> => {
      try {
        const storage = statsManager.getStorageUsage();
        return { success: true, data: storage };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATS_GET_STORAGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
