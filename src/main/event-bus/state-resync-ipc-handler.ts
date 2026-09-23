import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import type { IpcResponse } from '../../shared/types/ipc.types';
import type { StateSyncSnapshot } from '../../shared/types/thin-client-event.types';
import type { InstanceManager } from '../instance/instance-manager';
import { buildStateSyncSnapshot } from './state-sync-snapshot';

/** The preload sends `_withAuth()`: an otherwise-empty auth envelope. */
const StateResyncPayloadSchema = z.object({
  ipcAuthToken: z.string().max(500).optional(),
}).optional();

export interface StateResyncHandlerDeps {
  instanceManager: Pick<InstanceManager, 'getAllInstancesForIpc'>;
  ensureAuthorized?: (
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown,
  ) => IpcResponse | null;
  getSeq: () => number;
}

export function registerStateResyncHandler(deps: StateResyncHandlerDeps): void {
  ipcMain.handle(
    IPC_CHANNELS.STATE_RESYNC,
    async (event: IpcMainInvokeEvent, payload?: unknown): Promise<IpcResponse<StateSyncSnapshot>> => {
      const authError = deps.ensureAuthorized?.(event, IPC_CHANNELS.STATE_RESYNC, payload);
      if (authError) return authError as IpcResponse<StateSyncSnapshot>;

      try {
        validateIpcPayload(StateResyncPayloadSchema, payload, 'STATE_RESYNC');
        return {
          success: true,
          data: buildStateSyncSnapshot({
            instanceManager: deps.instanceManager,
            getSeq: deps.getSeq,
          }),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STATE_RESYNC_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
