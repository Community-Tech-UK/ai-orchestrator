/**
 * Codebase Indexing IPC Handlers
 * Handles codebase indexing, search, and file watching operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import type {
  CodebaseAutoIndexStatus,
  IndexingProgress,
  IndexingStats,
  IndexStats,
  HybridSearchResult,
  WatcherStatus
} from '../../../shared/types/codebase.types';
import { StoreIdSchema, validateIpcPayload } from '@contracts/schemas/common';
import {
  CodebaseIndexFilePayloadSchema,
  CodebaseIndexStorePayloadSchema,
  CodebaseWatcherPayloadSchema,
} from '@contracts/schemas/file-operations';
import {
  CodebaseSearchPayloadSchema,
  CodebaseSearchSymbolsPayloadSchema,
} from '@contracts/schemas/workspace-tools';
import { z } from 'zod';
import {
  getCodebaseIndexingService,
  getCodebaseFileWatcher,
  getCodebaseIndexingAutoCoordinator,
} from '../../indexing';
import { getCodebaseIndexingLaneGateway } from '../../indexing/codebase-indexing-lane-gateway';
import { getCodemem, getCodeRetrievalService } from '../../codemem';
import type {
  CodeIndexStatusSnapshot,
} from '../../codemem/index-worker-protocol';
import type { CodeRetrievalResult } from '../../codemem/code-retrieval-service';
import type { WindowManager } from '../../window-manager';

/**
 * Register codebase indexing handlers.
 * Accepts WindowManager to send events to renderer.
 */
export function registerCodebaseHandlers(windowManager: WindowManager): void {
  const indexingService = getCodebaseIndexingService();
  const fileWatcher = getCodebaseFileWatcher();
  const autoCoordinator = getCodebaseIndexingAutoCoordinator();
  const codeRetrievalService = getCodeRetrievalService();
  const indexingLaneGateway = getCodebaseIndexingLaneGateway();

  // Helper to safely send events to renderer
  const sendToRenderer = (channel: string, data: unknown): void => {
    const mainWindow = windowManager.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };

  // Forward progress events to renderer
  indexingService.on('progress', (progress: IndexingProgress) => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_INDEX_PROGRESS, progress);
  });
  indexingLaneGateway.on('progress', (progress: IndexingProgress) => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_INDEX_PROGRESS, progress);
  });

  // Forward file watcher events to renderer
  fileWatcher.on('changes:processed', (info: { storeId: string; additions: number; modifications: number; deletions: number }) => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_WATCHER_CHANGES, {
      storeId: info.storeId,
      count: info.additions + info.modifications + info.deletions
    });
  });

  // Forward auto-index status changes to renderer
  autoCoordinator.on('status', (status: CodebaseAutoIndexStatus) => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_AUTO_STATUS_CHANGED, status);
  });

  // ============================================
  // Indexing Handlers
  // ============================================

  // Index a codebase (full or incremental)
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_INDEX_STORE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<IndexingStats>> => {
      try {
        const validated = validateIpcPayload(CodebaseIndexStorePayloadSchema, payload, 'CODEBASE_INDEX_STORE');
        const stats = await indexingLaneGateway.indexCodebase(
          validated.storeId,
          validated.rootPath,
          validated.options
        );
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_INDEX_STORE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Index a single file
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_INDEX_FILE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<void>> => {
      try {
        const validated = validateIpcPayload(CodebaseIndexFilePayloadSchema, payload, 'CODEBASE_INDEX_FILE');
        await indexingService.indexFile(validated.storeId, validated.filePath);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_INDEX_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Cancel ongoing indexing
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_INDEX_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse<void>> => {
      try {
        const schema = z.object({
          workspacePath: z.string().min(1).max(4096).optional(),
          target: z.enum(['codemem', 'legacy']).optional(),
        }).optional();
        const validated = validateIpcPayload(schema, payload, 'CODEBASE_INDEX_CANCEL');
        if (validated?.target === 'legacy') {
          await indexingLaneGateway.cancelIndexCodebase(validated.workspacePath);
        } else if (validated?.workspacePath) {
          await getCodemem().indexWorkerGateway.cancelIndex(validated.workspacePath);
        } else {
          await indexingLaneGateway.cancelIndexCodebase();
          indexingService.cancel();
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_INDEX_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get current indexing status
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_INDEX_STATUS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse<IndexingProgress | CodeIndexStatusSnapshot | null>> => {
      try {
        const schema = z.object({
          workspacePath: z.string().min(1).max(4096).optional(),
          target: z.enum(['codemem', 'legacy']).optional(),
        }).optional();
        const validated = validateIpcPayload(schema, payload, 'CODEBASE_INDEX_STATUS');
        if (validated?.target === 'legacy') {
          const progress = indexingLaneGateway.getIndexCodebaseProgress(validated.workspacePath);
          return { success: true, data: progress };
        }
        if (validated?.workspacePath) {
          const progress = await getCodemem().indexWorkerGateway.getIndexStatus(validated.workspacePath);
          return { success: true, data: progress };
        }
        const laneProgress = indexingLaneGateway.getIndexCodebaseProgress();
        if (laneProgress) {
          return { success: true, data: laneProgress };
        }
        const progress = indexingService.getProgress();
        return { success: true, data: progress };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_INDEX_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get index stats for a store
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_INDEX_STATS,
    async (
      _event: IpcMainInvokeEvent,
      payload: { storeId: string }
    ): Promise<IpcResponse<IndexStats>> => {
      try {
        const validated = validateIpcPayload(
          z.object({ storeId: StoreIdSchema }),
          payload,
          'CODEBASE_INDEX_STATS'
        );
        const stats = await indexingService.getStats(validated.storeId);
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_INDEX_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear legacy RLM codebase index artifacts for diagnostics/reset flows.
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_LEGACY_CLEAR,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse<void>> => {
      try {
        const validated = validateIpcPayload(
          z.object({ storeId: StoreIdSchema }),
          payload,
          'CODEBASE_LEGACY_CLEAR',
        );
        await indexingService.clearLegacyCodebaseStore(validated.storeId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_LEGACY_CLEAR_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Search Handlers
  // ============================================

  // Code search, returned in the legacy HybridSearchResult shape for renderer compatibility.
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_SEARCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<HybridSearchResult[]>> => {
      try {
        const validated = validateIpcPayload(CodebaseSearchPayloadSchema, payload, 'CODEBASE_SEARCH');
        const workspacePath = validated.options.workspacePath
          ?? resolveWorkspacePathForStore(validated.options.storeId, autoCoordinator.listStatuses());
        const results = workspacePath
          ? await codeRetrievalService.search({
            workspacePath,
            query: validated.options.query,
            limit: validated.options.topK,
          })
          : [];
        return { success: true, data: results.map(mapRetrievalToHybridResult) };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_SEARCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Symbol search, returned in the legacy HybridSearchResult shape for renderer compatibility.
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_SEARCH_SYMBOLS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<HybridSearchResult[]>> => {
      try {
        const validated = validateIpcPayload(CodebaseSearchSymbolsPayloadSchema, payload, 'CODEBASE_SEARCH_SYMBOLS');
        const workspacePath = validated.workspacePath
          ?? resolveWorkspacePathForStore(validated.storeId, autoCoordinator.listStatuses());
        const results = workspacePath
          ? await codeRetrievalService.search({
            workspacePath,
            query: validated.query,
            limit: 20,
          })
          : [];
        return { success: true, data: results.map(mapRetrievalToHybridResult) };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_SEARCH_SYMBOLS_FAILED',
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

  // Start file watcher for a store
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_WATCHER_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<void>> => {
      try {
        const validated = validateIpcPayload(CodebaseWatcherPayloadSchema, payload, 'CODEBASE_WATCHER_START');

        if (!validated.rootPath) {
          return {
            success: false,
            error: {
              code: 'CODEBASE_WATCHER_START_FAILED',
              message: 'rootPath is required',
              timestamp: Date.now()
            }
          };
        }

        await fileWatcher.startWatching(validated.storeId, validated.rootPath);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_WATCHER_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Stop file watcher for a store
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_WATCHER_STOP,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<void>> => {
      try {
        const validated = validateIpcPayload(CodebaseWatcherPayloadSchema, payload, 'CODEBASE_WATCHER_STOP');
        await fileWatcher.stopWatching(validated.storeId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_WATCHER_STOP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get watcher status
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_WATCHER_STATUS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<WatcherStatus>> => {
      try {
        const validated = validateIpcPayload(CodebaseWatcherPayloadSchema, payload, 'CODEBASE_WATCHER_STATUS');
        const status = fileWatcher.getStatus(validated.storeId);
        if (!status) {
          return {
            success: true,
            data: {
              storeId: validated.storeId,
              rootPath: '',
              isWatching: false,
              pendingChanges: 0
            }
          };
        }
        return { success: true, data: status };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_WATCHER_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Auto-Index Coordinator Handlers
  // ============================================

  // Get the current auto-index status for a workspace (or all known statuses
  // when no rootPath is supplied).
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_AUTO_STATUS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<CodebaseAutoIndexStatus | CodebaseAutoIndexStatus[] | null>> => {
      try {
        const schema = z.object({ rootPath: z.string().min(1).max(4096).optional() }).optional();
        const validated = validateIpcPayload(schema, payload, 'CODEBASE_AUTO_STATUS_GET');
        if (validated?.rootPath) {
          const status = autoCoordinator.getStatus(validated.rootPath);
          return { success: true, data: status ?? null };
        }
        return { success: true, data: autoCoordinator.listStatuses() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_AUTO_STATUS_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Note: the legacy `CODEBASE_AUTO_HINT` handler has been removed. Renderer
  // hints now arrive on the consolidated `WORKSPACE_HINT_ACTIVE` channel and
  // are fanned out to this coordinator via `workspace-hint-handlers.ts`.
}

function resolveWorkspacePathForStore(
  storeId: string | undefined,
  statuses: CodebaseAutoIndexStatus[],
): string | null {
  if (!storeId) return null;
  return statuses.find((status) => status.storeId === storeId)?.rootPath ?? null;
}

function mapRetrievalToHybridResult(result: CodeRetrievalResult): HybridSearchResult {
  return {
    sectionId: `${result.relativePath}:${result.startLine}:${result.endLine}`,
    filePath: result.absolutePath,
    content: result.content,
    startLine: result.startLine,
    endLine: result.endLine,
    score: result.score,
    matchType: result.source === 'symbol' ? 'hybrid' : 'bm25',
    language: result.language,
    symbolName: result.symbolName ?? undefined,
  };
}
