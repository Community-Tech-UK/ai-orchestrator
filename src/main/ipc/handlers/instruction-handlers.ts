import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  InstructionsCreateDraftPayloadSchema,
  InstructionsResolvePayloadSchema,
  validateIpcPayload,
} from '@contracts/schemas';
import {
  createInstructionMigrationDraft,
  resolveInstructionStack,
} from '../../core/config/instruction-resolver';

export function registerInstructionHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTIONS_RESOLVE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstructionsResolvePayloadSchema,
          payload,
          'INSTRUCTIONS_RESOLVE',
        );
        const resolution = await resolveInstructionStack(validated);
        return {
          success: true,
          data: resolution,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'INSTRUCTIONS_RESOLVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTIONS_CREATE_DRAFT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstructionsCreateDraftPayloadSchema,
          payload,
          'INSTRUCTIONS_CREATE_DRAFT',
        );
        const resolution = await resolveInstructionStack(validated);
        const draft = createInstructionMigrationDraft(resolution);
        return {
          success: true,
          data: {
            ...draft,
            resolution,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'INSTRUCTIONS_CREATE_DRAFT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
