/**
 * Task/Subagent Management IPC Handlers
 * Handles task status, history, and queue operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  validateIpcPayload,
  TaskGetStatusPayloadSchema,
  TaskGetHistoryPayloadSchema,
  TaskGetByParentPayloadSchema,
  TaskGetByChildPayloadSchema,
  TaskCancelPayloadSchema,
  TaskGetPreflightPayloadSchema,
} from '@contracts/schemas';
import { getTaskManager } from '../../orchestration/task-manager';
import { getTaskPreflightService } from '../../security/task-preflight-service';

export function registerTaskHandlers(): void {
  const taskManager = getTaskManager();

  // Get task status by ID
  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_STATUS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TaskGetStatusPayloadSchema, payload, 'TASK_GET_STATUS');
        const task = taskManager.getTask(validated.taskId);
        return {
          success: true,
          data: task ? taskManager.serializeTask(task) : null
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TASK_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get task history
  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_HISTORY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TaskGetHistoryPayloadSchema, payload, 'TASK_GET_HISTORY');
        const history = taskManager.getTaskHistory(validated.parentId);
        return {
          success: true,
          data: history
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TASK_GET_HISTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get tasks by parent instance
  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_BY_PARENT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TaskGetByParentPayloadSchema, payload, 'TASK_GET_BY_PARENT');
        const tasks = taskManager.getTasksByParentId(validated.parentId);
        return {
          success: true,
          data: tasks.map((t) => taskManager.serializeTask(t))
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TASK_GET_BY_PARENT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get task by child instance
  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_BY_CHILD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TaskGetByChildPayloadSchema, payload, 'TASK_GET_BY_CHILD');
        const task = taskManager.getTaskByChildId(validated.childId);
        return {
          success: true,
          data: task ? taskManager.serializeTask(task) : null
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TASK_GET_BY_CHILD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Cancel a task
  ipcMain.handle(
    IPC_CHANNELS.TASK_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TaskCancelPayloadSchema, payload, 'TASK_CANCEL');
        const success = taskManager.cancelTask(validated.taskId);
        return {
          success: true,
          data: { cancelled: success }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TASK_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get task queue
  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_QUEUE,
    async (): Promise<IpcResponse> => {
      try {
        const stats = taskManager.getStats();
        return {
          success: true,
          data: stats
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TASK_GET_QUEUE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get launch preflight for a workflow/repo job/worktree/verification surface
  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_PREFLIGHT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          TaskGetPreflightPayloadSchema,
          payload,
          'TASK_GET_PREFLIGHT',
        );
        const report = await getTaskPreflightService().getPreflight(validated);
        return {
          success: true,
          data: report,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TASK_GET_PREFLIGHT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
