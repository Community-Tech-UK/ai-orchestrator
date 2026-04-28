/**
 * Search IPC Handlers
 * Handles semantic search, index building, and Exa configuration
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getSemanticSearchManager } from '../../workspace/semantic-search';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  SearchBuildIndexPayloadSchema,
  SearchConfigureExaPayloadSchema,
  SessionRecallSearchPayloadSchema,
  SearchSemanticPayloadSchema,
} from '@contracts/schemas/observability';
import { getSessionRecallService } from '../../session/session-recall-service';

export function registerSearchHandlers(): void {
  const searchManager = getSemanticSearchManager();

  // ============================================
  // Search Handlers
  // ============================================

  // Semantic search
  ipcMain.handle(
    IPC_CHANNELS.SEARCH_SEMANTIC,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SearchSemanticPayloadSchema, payload, 'SEARCH_SEMANTIC');
        const results = await searchManager.search({
          query: validated.query,
          directory: validated.directory ?? process.cwd(),
          maxResults: validated.maxResults,
          includePatterns: validated.includePatterns,
          excludePatterns: validated.excludePatterns,
          searchType: validated.searchType,
        });
        return { success: true, data: results };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEARCH_SEMANTIC_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Build index
  ipcMain.handle(
    IPC_CHANNELS.SEARCH_BUILD_INDEX,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SearchBuildIndexPayloadSchema, payload, 'SEARCH_BUILD_INDEX');
        await searchManager.buildIndex(
          validated.directory,
          validated.includePatterns || ['**/*.ts', '**/*.js', '**/*.py'],
          validated.excludePatterns || ['**/node_modules/**', '**/.git/**']
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEARCH_BUILD_INDEX_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Configure Exa
  ipcMain.handle(
    IPC_CHANNELS.SEARCH_CONFIGURE_EXA,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SearchConfigureExaPayloadSchema, payload, 'SEARCH_CONFIGURE_EXA');
        if (!validated.apiKey) {
          return {
            success: false,
            error: {
              code: 'SEARCH_CONFIGURE_EXA_FAILED',
              message: 'apiKey is required to configure Exa',
              timestamp: Date.now()
            }
          };
        }
        searchManager.configureExa({
          apiKey: validated.apiKey,
          baseUrl: validated.baseUrl,
        });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEARCH_CONFIGURE_EXA_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear index
  ipcMain.handle(
    IPC_CHANNELS.SEARCH_CLEAR_INDEX,
    async (): Promise<IpcResponse> => {
      try {
        searchManager.clearIndex();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEARCH_CLEAR_INDEX_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get index stats
  ipcMain.handle(
    IPC_CHANNELS.SEARCH_GET_INDEX_STATS,
    async (): Promise<IpcResponse> => {
      try {
        const stats = searchManager.getIndexStats();
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEARCH_GET_INDEX_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Check if Exa is configured
  ipcMain.handle(
    IPC_CHANNELS.SEARCH_IS_EXA_CONFIGURED,
    async (): Promise<IpcResponse> => {
      try {
        const isConfigured = searchManager.isExaConfigured();
        return { success: true, data: isConfigured };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEARCH_IS_EXA_CONFIGURED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_RECALL_SEARCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SessionRecallSearchPayloadSchema, payload ?? {}, 'SESSION_RECALL_SEARCH');
        const results = await getSessionRecallService().search({
          query: validated.query,
          parentId: validated.parentId,
          automationId: validated.automationId,
          limit: validated.limit,
        });
        return { success: true, data: results };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_RECALL_SEARCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
