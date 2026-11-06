import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type {
  CostRestoreInspection,
  CostRestoreRollbackSummary,
  CostRestoreSummary,
} from '../../shared/types/cost-history-restore.types';

/**
 * LT-707 cost history restoration — the user-triggered maintenance surface
 * for the A0 cost-entries originals (see cost-entries-a0-restore.ts).
 */
export function createCostHistoryRestoreDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    costHistoryRestoreStatus: (): Promise<IpcResponse<CostRestoreInspection>> =>
      ipcRenderer.invoke(ch.COST_HISTORY_RESTORE_STATUS),

    costHistoryRestoreApply: (): Promise<IpcResponse<CostRestoreSummary>> =>
      ipcRenderer.invoke(ch.COST_HISTORY_RESTORE_APPLY),

    costHistoryRestoreRollback: (): Promise<IpcResponse<CostRestoreRollbackSummary>> =>
      ipcRenderer.invoke(ch.COST_HISTORY_RESTORE_ROLLBACK),
  };
}
