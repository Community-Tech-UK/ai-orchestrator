/**
 * Debug and Logging IPC Handlers
 * Handles debug commands and logging operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getDebugCommandsManager } from '../../core/system/debug-commands';
import { getLogManager } from '../../logging/logger';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  DebugAgentPayloadSchema,
  DebugAllPayloadSchema,
  DebugConfigPayloadSchema,
  DebugFilePayloadSchema,
  LogExportPayloadSchema,
  LogGetRecentPayloadSchema,
  LogSetLevelPayloadSchema,
  LogSetSubsystemLevelPayloadSchema,
} from '@contracts/schemas/observability';

/**
 * Map log level string to LogLevel type
 */
function mapLogLevel(
  level: string
): 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
  const validLevels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
  if (validLevels.includes(level as (typeof validLevels)[number])) {
    return level as 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  }
  return 'info';
}

export function registerDebugHandlers(): void {
  const logManager = getLogManager();
  const debugManager = getDebugCommandsManager();

  // ============================================
  // Logging Handlers
  // ============================================

  // Get recent logs
  ipcMain.handle(
    IPC_CHANNELS.LOG_GET_RECENT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LogGetRecentPayloadSchema, payload, 'LOG_GET_RECENT');
        const logs = logManager.getRecentLogs({
          limit: validated?.limit,
          level: validated?.level ? mapLogLevel(validated.level) : undefined,
          subsystem: validated?.subsystem,
          startTime: validated?.startTime,
          endTime: validated?.endTime
        });
        return { success: true, data: logs };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_GET_RECENT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get config
  ipcMain.handle(
    IPC_CHANNELS.LOG_GET_CONFIG,
    async (): Promise<IpcResponse> => {
      try {
        const config = logManager.getConfig();
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_GET_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Set global log level
  ipcMain.handle(
    IPC_CHANNELS.LOG_SET_LEVEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LogSetLevelPayloadSchema, payload, 'LOG_SET_LEVEL');
        logManager.setGlobalLevel(mapLogLevel(validated.level));
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_SET_LEVEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Set subsystem log level
  ipcMain.handle(
    IPC_CHANNELS.LOG_SET_SUBSYSTEM_LEVEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LogSetSubsystemLevelPayloadSchema, payload, 'LOG_SET_SUBSYSTEM_LEVEL');
        logManager.setSubsystemLevel(
          validated.subsystem,
          mapLogLevel(validated.level)
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_SET_SUBSYSTEM_LEVEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear log buffer
  ipcMain.handle(
    IPC_CHANNELS.LOG_CLEAR_BUFFER,
    async (): Promise<IpcResponse> => {
      try {
        logManager.clearBuffer();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_CLEAR_BUFFER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Export logs
  ipcMain.handle(
    IPC_CHANNELS.LOG_EXPORT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LogExportPayloadSchema, payload, 'LOG_EXPORT');
        logManager.exportLogs(validated.filePath, {
          startTime: validated.startTime,
          endTime: validated.endTime
        });
        return { success: true, data: { filePath: validated.filePath } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_EXPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get subsystems
  ipcMain.handle(
    IPC_CHANNELS.LOG_GET_SUBSYSTEMS,
    async (): Promise<IpcResponse> => {
      try {
        const subsystems = logManager.getSubsystems();
        return { success: true, data: subsystems };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_GET_SUBSYSTEMS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get log files
  ipcMain.handle(
    IPC_CHANNELS.LOG_GET_FILES,
    async (): Promise<IpcResponse> => {
      try {
        const files = logManager.getLogFilePaths();
        return { success: true, data: files };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_GET_FILES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Debug Command Handlers
  // ============================================

  // Debug agent
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_AGENT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(DebugAgentPayloadSchema, payload, 'DEBUG_AGENT');
        const result = await debugManager.debugAgent(validated.agentId);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_AGENT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Debug config
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_CONFIG,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(DebugConfigPayloadSchema, payload, 'DEBUG_CONFIG');
        const result = await debugManager.debugConfig(
          validated.workingDirectory
        );
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Debug file
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_FILE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(DebugFilePayloadSchema, payload, 'DEBUG_FILE');
        const result = await debugManager.debugFile(validated.filePath);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Debug memory
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_MEMORY,
    async (): Promise<IpcResponse> => {
      try {
        const result = debugManager.debugMemory();
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_MEMORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Debug system
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_SYSTEM,
    async (): Promise<IpcResponse> => {
      try {
        const result = debugManager.debugSystem();
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_SYSTEM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Debug process
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_PROCESS,
    async (): Promise<IpcResponse> => {
      try {
        const result = debugManager.debugProcess();
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_PROCESS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Debug all
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_ALL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(DebugAllPayloadSchema, payload, 'DEBUG_ALL');
        const result = await debugManager.debugAll(validated.workingDirectory);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get memory history
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_GET_MEMORY_HISTORY,
    async (): Promise<IpcResponse> => {
      try {
        const history = debugManager.getMemoryHistory();
        return { success: true, data: history };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_GET_MEMORY_HISTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear memory history
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_CLEAR_MEMORY_HISTORY,
    async (): Promise<IpcResponse> => {
      try {
        debugManager.clearMemoryHistory();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_CLEAR_MEMORY_HISTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
