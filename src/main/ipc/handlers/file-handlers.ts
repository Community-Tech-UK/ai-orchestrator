/**
 * File Handlers - Editor, Watcher, and Multi-Edit operations
 * Handles external editor integration, file watching, and multi-file edits
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  EditorOpenDirectoryPayloadSchema,
  EditorOpenFileAtLinePayloadSchema,
  EditorOpenFilePayloadSchema,
  EditorSetPreferredPayloadSchema,
  MultiEditPayloadSchema,
  WatcherClearBufferPayloadSchema,
  WatcherGetChangesPayloadSchema,
  WatcherStartPayloadSchema,
  WatcherStopPayloadSchema,
} from '@contracts/schemas/file-operations';
import { getExternalEditorManager } from '../../workspace/editor/external-editor';
import { getFileWatcherManager } from '../../workspace/watcher/file-watcher';
import { getMultiEditManager } from '../../workspace/multiedit-manager';
import { WindowManager } from '../../window-manager';

export function registerFileHandlers(deps: {
  windowManager: WindowManager;
}): void {
  const { windowManager } = deps;

  // ============================================
  // External Editor Handlers
  // ============================================

  const editorManager = getExternalEditorManager();
  const editorSetDefaultPayloadSchema = z.object({
    editorId: z.string().min(1).max(200),
  });

  // Detect available editors
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_DETECT,
    async (): Promise<IpcResponse> => {
      try {
        const editors = await editorManager.detectEditors();
        return { success: true, data: editors };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_DETECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Open file in editor
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_OPEN_FILE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(EditorOpenFilePayloadSchema, payload, 'EDITOR_OPEN_FILE');
        const result = await editorManager.openFile(validated.filePath, {
          line: validated.line,
          column: validated.column,
          waitForClose: validated.waitForClose,
          newWindow: validated.newWindow
        });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_OPEN_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Open file at specific line
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_OPEN_FILE_AT_LINE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(EditorOpenFileAtLinePayloadSchema, payload, 'EDITOR_OPEN_FILE_AT_LINE');
        const result = await editorManager.openFileAtLine(
          validated.filePath,
          validated.line,
          validated.column
        );
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_OPEN_FILE_AT_LINE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Open directory in editor
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_OPEN_DIRECTORY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(EditorOpenDirectoryPayloadSchema, payload, 'EDITOR_OPEN_DIRECTORY');
        const result = await editorManager.openDirectory(validated.dirPath);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_OPEN_DIRECTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Set preferred editor
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_SET_PREFERRED,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(EditorSetPreferredPayloadSchema, payload, 'EDITOR_SET_PREFERRED');
        editorManager.setPreferredEditor({
          type: validated.type as import('../../workspace/editor/external-editor').EditorType,
          path: validated.path,
          args: validated.args
        });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_SET_PREFERRED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Set default editor (legacy alias for preferred editor)
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_SET_DEFAULT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(editorSetDefaultPayloadSchema, payload, 'EDITOR_SET_DEFAULT');
        const availableEditors = await editorManager.detectEditors();
        const selectedEditor = availableEditors.find((editor) =>
          editor.type === validated.editorId ||
          editor.name === validated.editorId ||
          editor.path === validated.editorId
        );

        if (!selectedEditor) {
          throw new Error(`Editor not found: ${validated.editorId}`);
        }

        editorManager.setPreferredEditor({
          type: selectedEditor.type,
          path: selectedEditor.path,
        });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_SET_DEFAULT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get preferred editor
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_GET_PREFERRED,
    async (): Promise<IpcResponse> => {
      try {
        const editor = editorManager.getPreferredEditor();
        return { success: true, data: editor };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_GET_PREFERRED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get default editor (legacy alias for preferred editor)
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_GET_DEFAULT,
    async (): Promise<IpcResponse> => {
      try {
        const editor = editorManager.getPreferredEditor();
        return { success: true, data: editor };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_GET_DEFAULT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get available editors
  ipcMain.handle(
    IPC_CHANNELS.EDITOR_GET_AVAILABLE,
    async (): Promise<IpcResponse> => {
      try {
        const editors = editorManager.getAvailableEditors();
        return { success: true, data: editors };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'EDITOR_GET_AVAILABLE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // File Watcher Handlers
  // ============================================

  const watcherManager = getFileWatcherManager();

  // Start watching
  ipcMain.handle(
    IPC_CHANNELS.WATCHER_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WatcherStartPayloadSchema, payload, 'WATCHER_START');
        const sessionId = await watcherManager.watch(validated.directory, {
          ignored: validated.ignored,
          useGitignore: validated.useGitignore,
          depth: validated.depth,
          ignoreInitial: validated.ignoreInitial
        });
        return { success: true, data: { sessionId } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WATCHER_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Stop watching
  ipcMain.handle(
    IPC_CHANNELS.WATCHER_STOP,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WatcherStopPayloadSchema, payload, 'WATCHER_STOP');
        await watcherManager.unwatch(validated.sessionId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WATCHER_STOP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Stop all watchers
  ipcMain.handle(
    IPC_CHANNELS.WATCHER_STOP_ALL,
    async (): Promise<IpcResponse> => {
      try {
        await watcherManager.unwatchAll();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WATCHER_STOP_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get active sessions
  ipcMain.handle(
    IPC_CHANNELS.WATCHER_GET_SESSIONS,
    async (): Promise<IpcResponse> => {
      try {
        const sessions = watcherManager.getActiveSessions();
        return { success: true, data: sessions };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WATCHER_GET_SESSIONS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get recent changes
  ipcMain.handle(
    IPC_CHANNELS.WATCHER_GET_CHANGES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WatcherGetChangesPayloadSchema, payload, 'WATCHER_GET_CHANGES');
        const changes = watcherManager.getRecentChanges(
          validated.sessionId,
          validated.limit
        );
        return { success: true, data: changes };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WATCHER_GET_CHANGES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear event buffer
  ipcMain.handle(
    IPC_CHANNELS.WATCHER_CLEAR_BUFFER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WatcherClearBufferPayloadSchema, payload, 'WATCHER_CLEAR_BUFFER');
        watcherManager.clearEventBuffer(validated.sessionId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WATCHER_CLEAR_BUFFER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Forward watcher events to renderer
  watcherManager.on('file-changed', (data) => {
    windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.WATCHER_FILE_CHANGED, data);
  });

  watcherManager.on('file-added', (data) => {
    windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.WATCHER_FILE_CHANGED, data);
  });

  watcherManager.on('file-removed', (data) => {
    windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.WATCHER_FILE_CHANGED, data);
  });

  watcherManager.on('error', (data) => {
    windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.WATCHER_ERROR, data);
  });

  // ============================================
  // Multi-Edit Handlers
  // ============================================

  const multiEdit = getMultiEditManager();

  // Preview edits without applying
  ipcMain.handle(
    IPC_CHANNELS.MULTIEDIT_PREVIEW,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(MultiEditPayloadSchema, payload, 'MULTIEDIT_PREVIEW');
        const preview = await multiEdit.preview(validated.edits);
        return {
          success: true,
          data: preview
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MULTIEDIT_PREVIEW_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Apply edits atomically
  ipcMain.handle(
    IPC_CHANNELS.MULTIEDIT_APPLY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(MultiEditPayloadSchema, payload, 'MULTIEDIT_APPLY');
        const result = await multiEdit.apply(validated.edits, {
          instanceId: validated.instanceId,
          takeSnapshots: validated.takeSnapshots
        });
        return {
          success: result.success,
          data: result,
          error: result.success
            ? undefined
            : {
                code: 'MULTIEDIT_APPLY_FAILED',
                message: result.error || 'Unknown error',
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MULTIEDIT_APPLY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
