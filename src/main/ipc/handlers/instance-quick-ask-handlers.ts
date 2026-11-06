/**
 * Quick-ask IPC handler (A8.1, Step 14c).
 *
 * One channel, one call into {@link askQuick}. The answer is never written to
 * the conversation and no push event is emitted.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import { InstanceQuickAskPayloadSchema } from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { askQuick } from '../../instance/quick-ask-service';
import type { InstanceManager } from '../../instance/instance-manager';

export function registerInstanceQuickAskHandlers(instanceManager: InstanceManager): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_QUICK_ASK,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceQuickAskPayloadSchema,
          payload,
          'INSTANCE_QUICK_ASK',
        );
        const result = await askQuick(instanceManager, validated.instanceId, validated.question);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'QUICK_ASK_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
