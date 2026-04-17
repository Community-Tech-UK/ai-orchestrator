import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getLogger } from '../../logging/logger';
import { getConversationMiner, ConversationMiner } from '../../memory/conversation-miner';
import {
  ConvoDetectFormatPayloadSchema,
  ConvoImportFilePayloadSchema,
  ConvoImportStringPayloadSchema,
} from '@contracts/schemas/knowledge';

const logger = getLogger('ConversationMiningHandlers');

export function registerConversationMiningHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONVO_IMPORT_FILE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = ConvoImportFilePayloadSchema.parse(payload);
        const result = getConversationMiner().importFile(data.filePath, data.wing);
        return { success: true, data: result };
      } catch (error) {
        logger.error('CONVO_IMPORT_FILE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CONVO_IMPORT_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONVO_IMPORT_STRING,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = ConvoImportStringPayloadSchema.parse(payload);
        const result = getConversationMiner().importFromString(data.content, {
          wing: data.wing,
          sourceFile: data.sourceFile,
          format: data.format,
        });
        return { success: true, data: result };
      } catch (error) {
        logger.error('CONVO_IMPORT_STRING failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CONVO_IMPORT_STRING_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONVO_DETECT_FORMAT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = ConvoDetectFormatPayloadSchema.parse(payload);
        const format = ConversationMiner.detectFormat(data.content);
        return { success: true, data: format };
      } catch (error) {
        logger.error('CONVO_DETECT_FORMAT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CONVO_DETECT_FORMAT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  logger.info('Conversation mining IPC handlers registered');
}
