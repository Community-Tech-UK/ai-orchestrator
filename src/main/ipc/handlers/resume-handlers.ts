import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  ResumeByIdPayloadSchema,
  ResumeForkNewPayloadSchema,
  ResumeLatestPayloadSchema,
  ResumeRestoreFallbackPayloadSchema,
  ResumeSwitchToLivePayloadSchema,
} from '@contracts/schemas/session';
import type { InstanceManager } from '../../instance/instance-manager';
import { getHistoryManager } from '../../history/history-manager';
import { HistoryRestoreError } from '../../history/history-restore-coordinator';

interface RegisterResumeHandlersDeps {
  instanceManager: InstanceManager;
}

export function registerResumeHandlers(deps: RegisterResumeHandlersDeps): void {
  const { instanceManager } = deps;

  ipcMain.handle(
    IPC_CHANNELS.RESUME_LATEST,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ResumeLatestPayloadSchema, payload ?? {}, 'RESUME_LATEST');
        const [entry] = getHistoryManager().getEntries({
          limit: 1,
          workingDirectory: validated.workingDirectory,
          projectScope: validated.workingDirectory ? 'current' : 'all',
          source: 'history-transcript',
        });

        if (!entry) {
          return errorResponse('RESUME_LATEST_NOT_FOUND', 'No resumable history entry found');
        }

        const result = await instanceManager.restoreFromHistory(entry.id, {
          workingDirectory: validated.workingDirectory,
        });
        return { success: true, data: result };
      } catch (error) {
        return restoreErrorResponse('RESUME_LATEST_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RESUME_BY_ID,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ResumeByIdPayloadSchema, payload, 'RESUME_BY_ID');
        const result = await instanceManager.restoreFromHistory(validated.entryId);
        return { success: true, data: result };
      } catch (error) {
        return restoreErrorResponse('RESUME_BY_ID_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RESUME_SWITCH_TO_LIVE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ResumeSwitchToLivePayloadSchema, payload, 'RESUME_SWITCH_TO_LIVE');
        const instance = instanceManager.getInstance(validated.instanceId);
        if (!instance) {
          return errorResponse('RESUME_LIVE_NOT_FOUND', `Live instance ${validated.instanceId} not found`);
        }
        return {
          success: true,
          data: {
            instanceId: instance.id,
            sessionId: instance.sessionId,
            historyThreadId: instance.historyThreadId,
          },
        };
      } catch (error) {
        return restoreErrorResponse('RESUME_SWITCH_TO_LIVE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RESUME_FORK_NEW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ResumeForkNewPayloadSchema, payload, 'RESUME_FORK_NEW');
        const forkAs = {
          sessionId: randomUUID(),
          historyThreadId: randomUUID(),
        };
        const result = await instanceManager.restoreFromHistory(validated.entryId, { forkAs });
        return { success: true, data: result };
      } catch (error) {
        return restoreErrorResponse('RESUME_FORK_NEW_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RESUME_RESTORE_FALLBACK,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ResumeRestoreFallbackPayloadSchema,
          payload,
          'RESUME_RESTORE_FALLBACK',
        );
        const result = await instanceManager.restoreFromHistory(validated.entryId, { forceFallback: true });
        return { success: true, data: result };
      } catch (error) {
        return restoreErrorResponse('RESUME_RESTORE_FALLBACK_FAILED', error);
      }
    },
  );
}

function errorResponse(code: string, message: string): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message,
      timestamp: Date.now(),
    },
  };
}

function restoreErrorResponse(fallbackCode: string, error: unknown): IpcResponse {
  const code = error instanceof HistoryRestoreError ? error.code : fallbackCode;
  return errorResponse(code, error instanceof Error ? error.message : String(error));
}
