import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstanceCompactPayloadSchema,
  InstanceRecoverCompactionContextPayloadSchema,
} from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { recoverCompactionContext } from '../../app/compaction-recovery';
import { getContextEngine } from '../../context/context-engine';
import type { InstanceManager } from '../../instance/instance-manager';

export function registerInstanceCompactionHandlers(instanceManager: InstanceManager): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_COMPACT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceCompactPayloadSchema,
          payload,
          'INSTANCE_COMPACT',
        );
        const result = await getContextEngine().compactInstance(validated.instanceId);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMPACT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_RECOVER_COMPACTION_CONTEXT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceRecoverCompactionContextPayloadSchema,
          payload,
          'INSTANCE_RECOVER_COMPACTION_CONTEXT',
        );
        const result = await recoverCompactionContext(validated, { instanceManager });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMPACTION_CONTEXT_RECOVERY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
