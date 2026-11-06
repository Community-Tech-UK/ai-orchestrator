/**
 * LT-707 cost history restoration — explicit maintenance IPC.
 *
 * These channels drive the application maintenance flow that restores the
 * Claude per-turn costs wrongly differenced by the old A0 history repair
 * (`core/system/cost-entries-a0-restore.ts`). Nothing here is wired to
 * startup: restoration runs only when the user explicitly asks for it from
 * the cost surface, and every run is atomic and reversible.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import type {
  CostRestoreInspection,
  CostRestoreRollbackSummary,
  CostRestoreSummary,
} from '../../../shared/types/cost-history-restore.types';
import {
  inspectStoredCostEntriesA0Restore,
  restoreStoredCostEntriesA0Backup,
  rollbackCostEntriesA0Restore,
} from '../../core/system/cost-entries-a0-restore';
import { getCostTracker } from '../../core/system/cost-tracker';
import { getRLMDatabase } from '../../persistence/rlm-database';
import { validatedHandler, type IpcResponse } from '../validated-handler';

const CostHistoryRestorePayloadSchema = z.object({}).optional();

export interface RegisterCostHistoryRestoreHandlersDeps {
  ensureTrustedSender?: (event: IpcMainInvokeEvent, channel: string) => IpcResponse | null;
}

export function registerCostHistoryRestoreHandlers(
  deps: RegisterCostHistoryRestoreHandlersDeps = {},
): void {
  const options = { ensureTrustedSender: deps.ensureTrustedSender };

  ipcMain.handle(
    IPC_CHANNELS.COST_HISTORY_RESTORE_STATUS,
    validatedHandler<Record<string, never> | undefined, CostRestoreInspection>(
      IPC_CHANNELS.COST_HISTORY_RESTORE_STATUS,
      CostHistoryRestorePayloadSchema,
      async () => ({
        success: true,
        data: inspectStoredCostEntriesA0Restore(getRLMDatabase().getRawDb()),
      }),
      options,
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.COST_HISTORY_RESTORE_APPLY,
    validatedHandler<Record<string, never> | undefined, CostRestoreSummary>(
      IPC_CHANNELS.COST_HISTORY_RESTORE_APPLY,
      CostHistoryRestorePayloadSchema,
      async () => {
        const data = restoreStoredCostEntriesA0Backup(getRLMDatabase().getRawDb());
        // The restore rewrote stored rows directly: reload the tracker's cached
        // window (read-only — setDatabase would flush the stale cache over the
        // repair) so summaries, history and budgets serve the repaired values
        // immediately instead of after the next restart. Runs synchronously
        // after the restore so nothing can interleave between the two.
        getCostTracker().reloadFromDatabase();
        return { success: true, data };
      },
      options,
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.COST_HISTORY_RESTORE_ROLLBACK,
    validatedHandler<Record<string, never> | undefined, CostRestoreRollbackSummary>(
      IPC_CHANNELS.COST_HISTORY_RESTORE_ROLLBACK,
      CostHistoryRestorePayloadSchema,
      async () => {
        const data = rollbackCostEntriesA0Restore(getRLMDatabase().getRawDb());
        getCostTracker().reloadFromDatabase();
        return { success: true, data };
      },
      options,
    ),
  );
}
