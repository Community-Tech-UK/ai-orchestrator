import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstanceCompactionApplyPayloadSchema,
  InstanceCompactionPreviewPayloadSchema,
  InstanceCompactPayloadSchema,
  InstanceRecoverCompactionContextPayloadSchema,
} from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { applyCompaction } from '../../app/compaction-runtime';
import { recoverCompactionContext } from '../../app/compaction-recovery';
import { previewCompaction } from '../../context/compaction-preview';
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
        // WS-B7: even the plain one-click "Compact Now" button now routes
        // through `applyCompaction()` (no boundary), so it gets a labeled
        // pre-compaction checkpoint like the boundary-aware dialog does.
        const result = await applyCompaction(instanceManager, validated.instanceId);
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
    IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceCompactionPreviewPayloadSchema,
          payload,
          'INSTANCE_COMPACTION_PREVIEW',
        );
        const result = await previewCompaction(instanceManager, validated.instanceId, {
          keepLatestExchanges: validated.keepLatestExchanges,
        });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMPACTION_PREVIEW_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_COMPACTION_APPLY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceCompactionApplyPayloadSchema,
          payload,
          'INSTANCE_COMPACTION_APPLY',
        );
        const result = await applyCompaction(instanceManager, validated.instanceId, {
          keepLatestExchanges: validated.keepLatestExchanges,
        });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMPACTION_APPLY_FAILED',
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
