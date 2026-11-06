import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { ClaudeCostReconcileSnapshot } from '../../shared/types/claude-cost-reconcile.types';
import type { IpcResponse } from './types';

export function createClaudeCostReconcileDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    /** The latest daily check of booked Claude spend against Claude's own totals. */
    claudeCostReconcileGet: (): Promise<IpcResponse<ClaudeCostReconcileSnapshot>> =>
      ipcRenderer.invoke(ch.CLAUDE_COST_RECONCILE_GET),

    /** Run the check now (shares one already running) and return the new snapshot. */
    claudeCostReconcileRun: (): Promise<IpcResponse<ClaudeCostReconcileSnapshot>> =>
      ipcRenderer.invoke(ch.CLAUDE_COST_RECONCILE_RUN),
  };
}
