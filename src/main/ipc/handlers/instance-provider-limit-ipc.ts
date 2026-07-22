import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstanceProviderLimitResumeNowPayloadSchema,
  InstanceProviderLimitCancelPayloadSchema,
  InstanceFailoverNowPayloadSchema,
  InstanceAuthRepairRetryPayloadSchema,
  InstanceAuthRepairCancelPayloadSchema,
} from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getInstanceProviderLimitHandler } from '../../instance/instance-provider-limit-handler';
import { getInstanceAuthRepairHandler } from '../../instance/instance-auth-repair-handler';
import type { InstanceManager } from '../../instance/instance-manager';

/**
 * IPC handlers for the (opt-in) regular-session provider-limit park: resume a
 * parked session immediately, or cancel its scheduled auto-resume. Extracted
 * from instance-handlers.ts to keep that file within its size ceiling.
 */
export function registerInstanceProviderLimitHandlers(deps: { instanceManager?: InstanceManager } = {}): void {
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

  // In-session auth repair — banner actions for a session the provider signed
  // out. Retry re-probes and resumes; cancel just dismisses.
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_AUTH_REPAIR_RETRY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceAuthRepairRetryPayloadSchema,
          payload,
          'INSTANCE_AUTH_REPAIR_RETRY',
        );
        const outcome = await getInstanceAuthRepairHandler().retryNow(validated.instanceId);
        return { success: true, data: outcome };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'AUTH_REPAIR_RETRY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_AUTH_REPAIR_CANCEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceAuthRepairCancelPayloadSchema,
          payload,
          'INSTANCE_AUTH_REPAIR_CANCEL',
        );
        const cancelled = getInstanceAuthRepairHandler().cancel(validated.instanceId);
        return { success: true, data: { cancelled } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'AUTH_REPAIR_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // WS7 Phase B — user-initiated provider switch (quota-park banner action).
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_FAILOVER_NOW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceFailoverNowPayloadSchema,
          payload,
          'INSTANCE_FAILOVER_NOW',
        );
        if (!deps.instanceManager) {
          throw new Error('Instance manager unavailable');
        }
        const outcome = await deps.instanceManager.failoverNow(validated.instanceId);
        return { success: true, data: outcome };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'INSTANCE_FAILOVER_NOW_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
