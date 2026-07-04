import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstanceProviderLimitResumeNowPayloadSchema,
  InstanceProviderLimitCancelPayloadSchema,
} from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getInstanceProviderLimitHandler } from '../../instance/instance-provider-limit-handler';

/**
 * IPC handlers for the (opt-in) regular-session provider-limit park: resume a
 * parked session immediately, or cancel its scheduled auto-resume. Extracted
 * from instance-handlers.ts to keep that file within its size ceiling.
 */
export function registerInstanceProviderLimitHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_PROVIDER_LIMIT_RESUME_NOW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceProviderLimitResumeNowPayloadSchema,
          payload,
          'INSTANCE_PROVIDER_LIMIT_RESUME_NOW',
        );
        const resumed = getInstanceProviderLimitHandler().resumeNow(validated.instanceId);
        return { success: true, data: { resumed } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_LIMIT_RESUME_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_PROVIDER_LIMIT_CANCEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceProviderLimitCancelPayloadSchema,
          payload,
          'INSTANCE_PROVIDER_LIMIT_CANCEL',
        );
        const cancelled = getInstanceProviderLimitHandler().cancel(validated.instanceId);
        return { success: true, data: { cancelled } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_LIMIT_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
