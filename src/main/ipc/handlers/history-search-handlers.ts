import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  HistoryExpandSnippetsPayloadSchema,
  HistorySearchAdvancedPayloadSchema,
} from '@contracts/schemas/session';
import { getAdvancedHistorySearch, type AdvancedHistorySearch } from '../../history/advanced-history-search';
import { getTranscriptSnippetService, type TranscriptSnippetService } from '../../history/transcript-snippet-service';

export interface RegisterHistorySearchHandlersDeps {
  search?: AdvancedHistorySearch;
  snippets?: TranscriptSnippetService;
}

export function registerHistorySearchHandlers(deps: RegisterHistorySearchHandlersDeps = {}): void {
  const search = deps.search ?? getAdvancedHistorySearch();
  const snippets = deps.snippets ?? getTranscriptSnippetService();

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_SEARCH_ADVANCED,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          HistorySearchAdvancedPayloadSchema,
          payload ?? {},
          'HISTORY_SEARCH_ADVANCED',
        );
        const result = await search.search(validated);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_SEARCH_ADVANCED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_EXPAND_SNIPPETS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          HistoryExpandSnippetsPayloadSchema,
          payload,
          'HISTORY_EXPAND_SNIPPETS',
        );
        const result = await snippets.expandSnippetsOnDemand(validated.entryId, validated.query);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_EXPAND_SNIPPETS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
