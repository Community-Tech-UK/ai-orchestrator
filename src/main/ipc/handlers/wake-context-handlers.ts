import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getLogger } from '../../logging/logger';
import { getWakeContextBuilder } from '../../memory/wake-context-builder';
import {
  WakeGeneratePayloadSchema,
  WakeAddHintPayloadSchema,
  WakeRemoveHintPayloadSchema,
  WakeSetIdentityPayloadSchema,
  WakeListHintsPayloadSchema,
} from '../../../shared/validation/ipc-schemas';

const logger = getLogger('WakeContextHandlers');

export function registerWakeContextHandlers(): void {
  const builder = getWakeContextBuilder();

  ipcMain.handle(
    IPC_CHANNELS.WAKE_GENERATE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = WakeGeneratePayloadSchema.parse(payload);
        const context = builder.generateWakeContext(data.wing);
        return { success: true, data: context };
      } catch (error) {
        logger.error('WAKE_GENERATE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'WAKE_GENERATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WAKE_GET_TEXT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = WakeGeneratePayloadSchema.parse(payload);
        const text = builder.getWakeUpText(data.wing);
        return { success: true, data: text };
      } catch (error) {
        logger.error('WAKE_GET_TEXT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'WAKE_GET_TEXT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WAKE_ADD_HINT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = WakeAddHintPayloadSchema.parse(payload);
        const id = builder.addHint(data.content, {
          importance: data.importance,
          room: data.room,
          sourceReflectionId: data.sourceReflectionId,
          sourceSessionId: data.sourceSessionId,
        });
        return { success: true, data: id };
      } catch (error) {
        logger.error('WAKE_ADD_HINT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'WAKE_ADD_HINT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WAKE_REMOVE_HINT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = WakeRemoveHintPayloadSchema.parse(payload);
        builder.removeHint(data.id);
        return { success: true, data: null };
      } catch (error) {
        logger.error('WAKE_REMOVE_HINT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'WAKE_REMOVE_HINT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WAKE_SET_IDENTITY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = WakeSetIdentityPayloadSchema.parse(payload);
        builder.setIdentity(data.text);
        return { success: true, data: null };
      } catch (error) {
        logger.error('WAKE_SET_IDENTITY failed', error as Error);
        return {
          success: false,
          error: {
            code: 'WAKE_SET_IDENTITY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WAKE_LIST_HINTS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = WakeListHintsPayloadSchema.parse(payload);
        const hints = builder.listHints(data.room);
        return { success: true, data: hints };
      } catch (error) {
        logger.error('WAKE_LIST_HINTS failed', error as Error);
        return {
          success: false,
          error: {
            code: 'WAKE_LIST_HINTS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  logger.info('Wake context IPC handlers registered');
}
