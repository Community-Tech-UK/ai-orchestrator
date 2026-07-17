import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstructionsCreateDraftPayloadSchema,
  InstructionsResolvePayloadSchema,
  InstructionTrustApprovePayloadSchema,
  InstructionTrustRevokePayloadSchema,
} from '@contracts/schemas/settings';
import { InstructionTrustStore } from '../../security/instruction-trust-store';
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

  // ── WS12 instruction trust: approve (batch) / revoke / list ───────────────
  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTION_TRUST_APPROVE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstructionTrustApprovePayloadSchema,
          payload,
          'INSTRUCTION_TRUST_APPROVE',
        );
        const store = InstructionTrustStore.getInstance();
        const pins = validated.files.map((file) => store.approve(file.path, file.sha256));
        return { success: true, data: { pins } };
      } catch (error) {
        return {
          success: false,
          error: { code: 'INSTRUCTION_TRUST_APPROVE_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTION_TRUST_REVOKE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstructionTrustRevokePayloadSchema,
          payload,
          'INSTRUCTION_TRUST_REVOKE',
        );
        InstructionTrustStore.getInstance().revoke(validated.path);
        return { success: true, data: { revoked: validated.path } };
      } catch (error) {
        return {
          success: false,
          error: { code: 'INSTRUCTION_TRUST_REVOKE_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTION_TRUST_LIST,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: { pins: InstructionTrustStore.getInstance().list() } };
      } catch (error) {
        return {
          success: false,
          error: { code: 'INSTRUCTION_TRUST_LIST_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );
}
