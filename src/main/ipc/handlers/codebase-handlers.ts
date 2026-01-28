/**
 * Codebase Indexing IPC Handlers
 * Handles codebase indexing, search, and file watching operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import type {
  CodebaseIndexStorePayload,
  CodebaseIndexFilePayload,
  CodebaseSearchPayload,
  CodebaseWatcherPayload,
  IndexingProgress,
  IndexingStats,
  IndexStats,
  HybridSearchResult,
  WatcherStatus
} from '../../../shared/types/codebase.types';
import {
  getCodebaseIndexingService,
  getHybridSearchService,
  getCodebaseFileWatcher
} from '../../indexing';
import { RLMDatabase } from '../../persistence/rlm-database';
import type { WindowManager } from '../../window-manager';

/**
 * Register codebase indexing handlers.
 * Accepts WindowManager to send events to renderer.
 */
export function registerCodebaseHandlers(windowManager: WindowManager): void {
  const indexingService = getCodebaseIndexingService();
  const db = RLMDatabase.getInstance();
  const searchService = getHybridSearchService(db['db']);
  const fileWatcher = getCodebaseFileWatcher();

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

  // Forward file watcher events to renderer
  fileWatcher.on('changes:processed', (info: { storeId: string; additions: number; modifications: number; deletions: number }) => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_WATCHER_CHANGES, {
      storeId: info.storeId,
      count: info.additions + info.modifications + info.deletions
    });
  });

  // ============================================
  // Indexing Handlers
  // ============================================

  // Index a codebase (full or incremental)
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_INDEX_STORE,
    async (
      _event: IpcMainInvokeEvent,
      payload: CodebaseIndexStorePayload
    ): Promise<IpcResponse<IndexingStats>> => {
      try {
        const stats = await indexingService.indexCodebase(
          payload.storeId,
          payload.rootPath,
          payload.options
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
      payload: CodebaseIndexFilePayload
    ): Promise<IpcResponse<void>> => {
      try {
        await indexingService.indexFile(payload.storeId, payload.filePath);
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
    async (): Promise<IpcResponse<void>> => {
      try {
        indexingService.cancel();
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
    async (): Promise<IpcResponse<IndexingProgress>> => {
      try {
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
        const stats = await indexingService.getStats(payload.storeId);
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

  // ============================================
  // Search Handlers
  // ============================================

  // Hybrid search (BM25 + vector + reranking)
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_SEARCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: CodebaseSearchPayload
    ): Promise<IpcResponse<HybridSearchResult[]>> => {
      try {
        const results = await searchService.search(payload.options);
        return { success: true, data: results };
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

  // Symbol search - uses BM25 search with symbol boosting
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_SEARCH_SYMBOLS,
    async (
      _event: IpcMainInvokeEvent,
      payload: { storeId: string; query: string }
    ): Promise<IpcResponse<HybridSearchResult[]>> => {
      try {
        // For symbol search, use hybrid search with BM25 boosting for symbols
        const results = await searchService.search({
          query: payload.query,
          storeId: payload.storeId,
          topK: 20,
          bm25Weight: 0.7,  // Favor keyword matching for symbols
          vectorWeight: 0.3,
          useHyDE: false    // Disable HyDE for exact symbol matching
        });
        return { success: true, data: results };
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
      payload: CodebaseWatcherPayload
    ): Promise<IpcResponse<void>> => {
      try {
        if (!payload.rootPath) {
          return {
            success: false,
            error: {
              code: 'CODEBASE_WATCHER_START_FAILED',
              message: 'rootPath is required',
              timestamp: Date.now()
            }
          };
        }

        await fileWatcher.startWatching(payload.storeId, payload.rootPath);
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
      payload: CodebaseWatcherPayload
    ): Promise<IpcResponse<void>> => {
      try {
        await fileWatcher.stopWatching(payload.storeId);
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
      payload: CodebaseWatcherPayload
    ): Promise<IpcResponse<WatcherStatus>> => {
      try {
        const status = fileWatcher.getStatus(payload.storeId);
        if (!status) {
          return {
            success: true,
            data: {
              storeId: payload.storeId,
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
}
