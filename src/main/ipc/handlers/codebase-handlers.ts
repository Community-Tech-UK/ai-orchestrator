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
import { StoreIdSchema } from '@contracts/schemas/common';
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
import { validatedHandler } from '../validated-handler';
import { getCodebaseFileWatcher } from '../../indexing/file-watcher';
import { getCodebaseIndexingAutoCoordinator } from '../../indexing/codebase-indexing-auto-coordinator';
import { getCodebaseIndexingLaneGateway } from '../../indexing/codebase-indexing-lane-gateway';
import { getCodemem, getCodeRetrievalService } from '../../codemem';
import type {
  CodeIndexStatusSnapshot,
} from '../../codemem/index-worker-protocol';
import type { CodeRetrievalResult } from '../../codemem/code-retrieval-service';
import type { WindowManager } from '../../window-manager';

const CodebaseIndexTargetPayloadSchema = z.object({
  workspacePath: z.string().min(1).max(4096).optional(),
  target: z.enum(['codemem', 'legacy']).optional(),
}).optional();

const CodebaseStoreIdPayloadSchema = z.object({ storeId: StoreIdSchema });

const CodebaseAutoStatusPayloadSchema = z.object({
  rootPath: z.string().min(1).max(4096).optional(),
}).optional();

/**
 * Register codebase indexing handlers.
 * Accepts WindowManager to send events to renderer.
 */
export interface CodebaseHandlerRegistration {
  dispose(): void;
}

export function registerCodebaseHandlers(
  windowManager: WindowManager,
): CodebaseHandlerRegistration {
  const fileWatcher = getCodebaseFileWatcher();
  const autoCoordinator = getCodebaseIndexingAutoCoordinator();
  const codeRetrievalService = getCodeRetrievalService();
  const indexingLaneGateway = getCodebaseIndexingLaneGateway();
  const cleanupTasks: Array<() => void> = [];

  // Helper to safely send events to renderer
  const sendToRenderer = (channel: string, data: unknown): void => {
    windowManager.sendToRenderer(channel, data);
  };

  // Forward progress events to renderer
  const onIndexingProgress = (progress: IndexingProgress): void => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_INDEX_PROGRESS, progress);
  };

  // Forward file watcher events to renderer
  const onWatcherChanges = (info: { storeId: string; additions: number; modifications: number; deletions: number }): void => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_WATCHER_CHANGES, {
      storeId: info.storeId,
      count: info.additions + info.modifications + info.deletions
    });
  };

  // Forward auto-index status changes to renderer
  const onAutoIndexStatus = (status: CodebaseAutoIndexStatus): void => {
    sendToRenderer(IPC_CHANNELS.CODEBASE_AUTO_STATUS_CHANGED, status);
  };

  try {
    indexingLaneGateway.on('progress', onIndexingProgress);
    cleanupTasks.push(() => indexingLaneGateway.off('progress', onIndexingProgress));
    fileWatcher.on('changes:processed', onWatcherChanges);
    cleanupTasks.push(() => fileWatcher.off('changes:processed', onWatcherChanges));
    autoCoordinator.on('status', onAutoIndexStatus);
    cleanupTasks.push(() => autoCoordinator.off('status', onAutoIndexStatus));

    const registerHandler = <T>(
      channel: string,
      schema: z.ZodSchema<T>,
      listener: (
        validated: T,
        event: IpcMainInvokeEvent,
      ) => Promise<IpcResponse<unknown>>,
      errorCode?: string,
    ): void => {
      ipcMain.handle(
        channel,
        validatedHandler(channel, schema, listener, { errorCode }),
      );
      cleanupTasks.push(() => ipcMain.removeHandler(channel));
    };

  // ============================================
  // Indexing Handlers
  // ============================================

  // Index a codebase (full or incremental)
  registerHandler(
    IPC_CHANNELS.CODEBASE_INDEX_STORE,
    CodebaseIndexStorePayloadSchema,
    async (validated) => {
      const stats = await indexingLaneGateway.indexCodebase(
        validated.storeId,
        validated.rootPath,
        validated.options,
      );
      return { success: true, data: stats };
    },
    'CODEBASE_INDEX_STORE_FAILED',
  );

  // Index a single file
  registerHandler(
    IPC_CHANNELS.CODEBASE_INDEX_FILE,
    CodebaseIndexFilePayloadSchema,
    async (validated) => {
      await indexingLaneGateway.indexFile(validated.storeId, validated.filePath);
      return { success: true };
    },
    'CODEBASE_INDEX_FILE_FAILED',
  );

  // Cancel ongoing indexing
  registerHandler(
    IPC_CHANNELS.CODEBASE_INDEX_CANCEL,
    CodebaseIndexTargetPayloadSchema,
    async (validated) => {
      if (validated?.target === 'legacy') {
        await indexingLaneGateway.cancelIndexCodebase(validated.workspacePath);
      } else if (validated?.workspacePath) {
        await getCodemem().indexWorkerGateway.cancelIndex(validated.workspacePath);
      } else {
        await indexingLaneGateway.cancelIndexCodebase();
      }
      return { success: true };
    },
    'CODEBASE_INDEX_CANCEL_FAILED',
  );

  // Get current indexing status
  registerHandler(
    IPC_CHANNELS.CODEBASE_INDEX_STATUS,
    CodebaseIndexTargetPayloadSchema,
    async (validated) => {
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
      return {
        success: true,
        data: {
          status: 'idle',
          totalFiles: 0,
          processedFiles: 0,
          totalChunks: 0,
        },
      };
    },
    'CODEBASE_INDEX_STATUS_FAILED',
  );

  // Get index stats for a store
  registerHandler(
    IPC_CHANNELS.CODEBASE_INDEX_STATS,
    CodebaseStoreIdPayloadSchema,
    async (validated) => {
      const stats = await indexingLaneGateway.getStats(validated.storeId);
      return { success: true, data: stats };
    },
    'CODEBASE_INDEX_STATS_FAILED',
  );

  // Clear legacy RLM codebase index artifacts for diagnostics/reset flows.
  registerHandler(
    IPC_CHANNELS.CODEBASE_LEGACY_CLEAR,
    CodebaseStoreIdPayloadSchema,
    async (validated) => {
      await indexingLaneGateway.clearLegacyCodebaseStore(validated.storeId);
      return { success: true };
    },
    'CODEBASE_LEGACY_CLEAR_FAILED',
  );

  // ============================================
  // Search Handlers
  // ============================================

  // Code search, returned in the legacy HybridSearchResult shape for renderer compatibility.
  registerHandler(
    IPC_CHANNELS.CODEBASE_SEARCH,
    CodebaseSearchPayloadSchema,
    async (validated) => {
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
    },
    'CODEBASE_SEARCH_FAILED',
  );

  // Symbol search, returned in the legacy HybridSearchResult shape for renderer compatibility.
  registerHandler(
    IPC_CHANNELS.CODEBASE_SEARCH_SYMBOLS,
    CodebaseSearchSymbolsPayloadSchema,
    async (validated) => {
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
    },
    'CODEBASE_SEARCH_SYMBOLS_FAILED',
  );

  // ============================================
  // File Watcher Handlers
  // ============================================

  // Start file watcher for a store
  registerHandler(
    IPC_CHANNELS.CODEBASE_WATCHER_START,
    CodebaseWatcherPayloadSchema,
    async (validated) => {
      if (!validated.rootPath) {
        return {
          success: false,
          error: {
            code: 'CODEBASE_WATCHER_START_FAILED',
            message: 'rootPath is required',
            timestamp: Date.now(),
          },
        };
      }

      await fileWatcher.startWatching(validated.storeId, validated.rootPath);
      return { success: true };
    },
    'CODEBASE_WATCHER_START_FAILED',
  );

  // Stop file watcher for a store
  registerHandler(
    IPC_CHANNELS.CODEBASE_WATCHER_STOP,
    CodebaseWatcherPayloadSchema,
    async (validated) => {
      await fileWatcher.stopWatching(validated.storeId);
      return { success: true };
    },
    'CODEBASE_WATCHER_STOP_FAILED',
  );

  // Get watcher status
  registerHandler(
    IPC_CHANNELS.CODEBASE_WATCHER_STATUS,
    CodebaseWatcherPayloadSchema,
    async (validated) => {
      const status = fileWatcher.getStatus(validated.storeId);
      if (!status) {
        return {
          success: true,
          data: {
            storeId: validated.storeId,
            rootPath: '',
            isWatching: false,
            pendingChanges: 0,
          },
        };
      }
      return { success: true, data: status };
    },
    'CODEBASE_WATCHER_STATUS_FAILED',
  );

  // ============================================
  // Auto-Index Coordinator Handlers
  // ============================================

  // Get the current auto-index status for a workspace (or all known statuses
  // when no rootPath is supplied).
  registerHandler(
    IPC_CHANNELS.CODEBASE_AUTO_STATUS_GET,
    CodebaseAutoStatusPayloadSchema,
    async (validated) => {
      if (validated?.rootPath) {
        const status = autoCoordinator.getStatus(validated.rootPath);
        return { success: true, data: status ?? null };
      }
      return { success: true, data: autoCoordinator.listStatuses() };
    },
    'CODEBASE_AUTO_STATUS_GET_FAILED',
  );

  // Note: the legacy `CODEBASE_AUTO_HINT` handler has been removed. Renderer
  // hints now arrive on the consolidated `WORKSPACE_HINT_ACTIVE` channel and
  // are fanned out to this coordinator via `workspace-hint-handlers.ts`.
  } catch (registrationError) {
    const cleanupErrors = runCodebaseRegistrationCleanup(cleanupTasks);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [registrationError, ...cleanupErrors],
        'Codebase handler registration and rollback failed',
      );
    }
    throw registrationError;
  }

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const cleanupErrors = runCodebaseRegistrationCleanup(cleanupTasks);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Codebase handler cleanup failed');
      }
    },
  };
}

function runCodebaseRegistrationCleanup(cleanupTasks: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const cleanup of cleanupTasks.reverse()) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  cleanupTasks.length = 0;
  return errors;
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
