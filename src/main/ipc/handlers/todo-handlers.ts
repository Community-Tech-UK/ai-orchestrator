/**
 * TODO IPC Handlers
 * Handles TODO list management for instances
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  TodoClearPayloadSchema,
  TodoCreatePayloadSchema,
  TodoDeletePayloadSchema,
  TodoGetCurrentPayloadSchema,
  TodoGetListPayloadSchema,
  TodoUpdatePayloadSchema,
  TodoWriteAllPayloadSchema,
} from '@contracts/schemas/session';
import { getTodoManager } from '../../tasks/todo-manager';
import type { WindowManager } from '../../window-manager';

export function registerTodoHandlers(deps: {
  windowManager: WindowManager;
}): void {
  const todos = getTodoManager();

  // Set up event forwarding to renderer
  todos.on('todos:changed', (sessionId, list) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.TODO_LIST_CHANGED, { sessionId, list });
  });

  // Get TODO list for a session
  ipcMain.handle(
    IPC_CHANNELS.TODO_GET_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TodoGetListPayloadSchema, payload, 'TODO_GET_LIST');
        const list = todos.getTodoList(validated.sessionId);
        return {
          success: true,
          data: list
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TODO_GET_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Create a TODO
  ipcMain.handle(
    IPC_CHANNELS.TODO_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TodoCreatePayloadSchema, payload, 'TODO_CREATE');
        const item = todos.createTodo(validated.sessionId, {
          content: validated.content,
          activeForm: validated.activeForm,
          priority: validated.priority,
          parentId: validated.parentId
        });
        return {
          success: true,
          data: item
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TODO_CREATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update a TODO
  ipcMain.handle(
    IPC_CHANNELS.TODO_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TodoUpdatePayloadSchema, payload, 'TODO_UPDATE');
        const item = todos.updateTodo(validated.sessionId, {
          id: validated.todoId,
          content: validated.content,
          activeForm: validated.activeForm,
          status: validated.status,
          priority: validated.priority
        });
        if (!item) {
          return {
            success: false,
            error: {
              code: 'TODO_NOT_FOUND',
              message: `TODO ${validated.todoId} not found`,
              timestamp: Date.now()
            }
          };
        }
        return {
          success: true,
          data: item
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TODO_UPDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Delete a TODO
  ipcMain.handle(
    IPC_CHANNELS.TODO_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TodoDeletePayloadSchema, payload, 'TODO_DELETE');
        const deleted = todos.deleteTodo(validated.sessionId, validated.todoId);
        return {
          success: deleted,
          error: deleted
            ? undefined
            : {
                code: 'TODO_NOT_FOUND',
                message: `TODO ${validated.todoId} not found`,
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TODO_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Write all TODOs (replaces existing - matches Claude's TodoWrite format)
  ipcMain.handle(
    IPC_CHANNELS.TODO_WRITE_ALL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TodoWriteAllPayloadSchema, payload, 'TODO_WRITE_ALL');
        const list = todos.writeTodos(validated.sessionId, validated.todos);
        return {
          success: true,
          data: list
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TODO_WRITE_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear all TODOs for a session
  ipcMain.handle(
    IPC_CHANNELS.TODO_CLEAR,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TodoClearPayloadSchema, payload, 'TODO_CLEAR');
        todos.clearTodos(validated.sessionId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TODO_CLEAR_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get the current in-progress TODO
  ipcMain.handle(
    IPC_CHANNELS.TODO_GET_CURRENT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(TodoGetCurrentPayloadSchema, payload, 'TODO_GET_CURRENT');
        const current = todos.getCurrentTodo(validated.sessionId);
        return {
          success: true,
          data: current || null
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TODO_GET_CURRENT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
