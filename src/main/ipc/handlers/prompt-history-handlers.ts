import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  PromptHistoryClearInstancePayloadSchema,
  PromptHistoryGetSnapshotPayloadSchema,
  PromptHistoryRecordPayloadSchema,
} from '@contracts/schemas/prompt-history';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import type { PromptHistoryDelta } from '../../../shared/types/prompt-history.types';
import { getPromptHistoryService, type PromptHistoryService } from '../../prompt-history/prompt-history-service';
import type { WindowManager } from '../../window-manager';

export interface RegisterPromptHistoryHandlersDeps {
  windowManager: Pick<WindowManager, 'sendToRenderer'>;
  service?: PromptHistoryService;
}

export function registerPromptHistoryHandlers(deps: RegisterPromptHistoryHandlersDeps): void {
  const service = deps.service ?? getPromptHistoryService();

  ipcMain.handle(
    IPC_CHANNELS.PROMPT_HISTORY_GET_SNAPSHOT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        validateIpcPayload(
          PromptHistoryGetSnapshotPayloadSchema,
          payload ?? {},
          'PROMPT_HISTORY_GET_SNAPSHOT',
        );
        return { success: true, data: service.getSnapshot() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROMPT_HISTORY_GET_SNAPSHOT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROMPT_HISTORY_RECORD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PromptHistoryRecordPayloadSchema,
          payload,
          'PROMPT_HISTORY_RECORD',
        );
        const record = service.record({
          instanceId: validated.instanceId,
          ...validated.entry,
        });
        return { success: true, data: record };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROMPT_HISTORY_RECORD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROMPT_HISTORY_CLEAR_INSTANCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PromptHistoryClearInstancePayloadSchema,
          payload,
          'PROMPT_HISTORY_CLEAR_INSTANCE',
        );
        const record = service.clearForInstance(validated.instanceId);
        return { success: true, data: record };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROMPT_HISTORY_CLEAR_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  service.onChange((delta: PromptHistoryDelta) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.PROMPT_HISTORY_DELTA, delta);
  });
}
