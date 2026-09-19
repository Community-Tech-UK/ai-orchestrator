import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import { LoopByIdPayloadSchema } from '@contracts/schemas/loop';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import {
  resolveBlockedLoopWorktree,
  type LoopWorktreeResolveStore,
} from '../../orchestration/loop-worktree-resolve';

/** Operator action: mark a run's blocked managed worktree as resolved by hand. */
export function registerLoopWorktreeResolveHandler(store: LoopWorktreeResolveStore): void {
  ipcMain.handle(
    IPC_CHANNELS.LOOP_RESOLVE_BLOCKED_WORKTREE,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          LoopByIdPayloadSchema, payload, 'LOOP_RESOLVE_BLOCKED_WORKTREE',
        );
        const result = await resolveBlockedLoopWorktree(store, validated.loopRunId);
        if (result.status === 'refused') {
          return {
            success: false,
            error: {
              code: 'LOOP_RESOLVE_BLOCKED_WORKTREE_REFUSED',
              message: result.reason,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: { lifecycle: result.lifecycle } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOOP_RESOLVE_BLOCKED_WORKTREE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
