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

interface DebugCommandDescriptor {
  id: string;
  label: string;
  description: string;
}

const DEBUG_COMMANDS: DebugCommandDescriptor[] = [
  { id: 'agent', label: 'Agent', description: 'Inspect built-in agent metadata.' },
  { id: 'config', label: 'Config', description: 'Inspect configuration resolution and app paths.' },
  { id: 'file', label: 'File', description: 'Inspect file existence, permissions, and encoding.' },
  { id: 'memory', label: 'Memory', description: 'Capture process memory usage.' },
  { id: 'system', label: 'System', description: 'Inspect OS and Electron runtime details.' },
  { id: 'process', label: 'Process', description: 'Inspect process argv, environment, and resource usage.' },
  { id: 'all', label: 'All', description: 'Run all non-file diagnostic commands.' },
];

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeLogOptions(payload: unknown): {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  subsystem?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
} {
  const root = asRecord(payload);
  const options = asRecord(root?.['options']) ?? root;
  return {
    level: typeof options?.['level'] === 'string' ? mapLogLevel(options['level']) : undefined,
    subsystem: stringValue(options?.['subsystem']) ?? stringValue(options?.['context']),
    startTime: numberValue(options?.['startTime']),
    endTime: numberValue(options?.['endTime']),
    limit: numberValue(options?.['limit']),
  };
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

  // Renderer-facing alias used by the Logs page.
  ipcMain.handle(
    IPC_CHANNELS.LOG_GET_LOGS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const logs = logManager.getRecentLogs(normalizeLogOptions(payload));
        return { success: true, data: logs };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_GET_LOGS_FAILED',
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

  // Renderer-facing alias used by the Logs page.
  ipcMain.handle(
    IPC_CHANNELS.LOG_CLEAR,
    async (): Promise<IpcResponse> => {
      try {
        logManager.clearBuffer();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOG_CLEAR_FAILED',
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

  // Execute a renderer-selected debug command.
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_EXECUTE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const root = asRecord(payload);
        const command = stringValue(root?.['command']);
        const args = asRecord(root?.['args']);
        if (!command) {
          throw new Error('Debug command is required');
        }

        let data: unknown;
        switch (command) {
          case 'agent':
            data = await debugManager.debugAgent(stringValue(args?.['agentId']));
            break;
          case 'config':
            data = await debugManager.debugConfig(stringValue(args?.['workingDirectory']));
            break;
          case 'file': {
            const filePath = stringValue(args?.['filePath']);
            if (!filePath) {
              throw new Error('filePath is required for the file debug command');
            }
            data = await debugManager.debugFile(filePath);
            break;
          }
          case 'memory':
            data = debugManager.debugMemory();
            break;
          case 'system':
            data = debugManager.debugSystem();
            break;
          case 'process':
            data = debugManager.debugProcess();
            break;
          case 'all':
            data = await debugManager.debugAll(stringValue(args?.['workingDirectory']));
            break;
          default:
            throw new Error(`Unknown debug command: ${command}`);
        }

        return { success: true, data };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_EXECUTE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // List commands for the renderer command picker.
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_GET_COMMANDS,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: DEBUG_COMMANDS };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_GET_COMMANDS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Lightweight debug surface metadata.
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_GET_INFO,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: {
            commands: DEBUG_COMMANDS,
            logConfig: logManager.getConfig(),
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_GET_INFO_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Run the non-file diagnostics suite.
  ipcMain.handle(
    IPC_CHANNELS.DEBUG_RUN_DIAGNOSTICS,
    async (): Promise<IpcResponse> => {
      try {
        const data = await debugManager.debugAll();
        return { success: true, data };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DEBUG_RUN_DIAGNOSTICS_FAILED',
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
