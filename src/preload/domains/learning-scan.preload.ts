import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

/**
 * WS-B8 fail->fix correction scan: manual trigger + status/last-result read.
 * The scan only raises/reinforces `pending` governed 'rule' proposals — it
 * never promotes anything on its own.
 */
export function createLearningScanDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    learningScanRun: (payload?: {
      workspaceId?: string;
      sessionLimit?: number;
      sinceTs?: number;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.LEARNING_SCAN_RUN, payload),

    learningScanGetStatus: (workspaceId?: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LEARNING_SCAN_GET_STATUS, workspaceId ? { workspaceId } : undefined),
  };
}
