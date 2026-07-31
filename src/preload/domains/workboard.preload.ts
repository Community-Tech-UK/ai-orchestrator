import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { OperationalDecision } from '@contracts/schemas/workboard';

export function createWorkboardDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    workboardGetDecisionsForItem: (payload: {
      loopRunId?: string;
      automationRunId?: string;
      instanceId?: string;
    }): Promise<IpcResponse<OperationalDecision[]>> => {
      return ipcRenderer.invoke(ch.WORKBOARD_DECISIONS_FOR_ITEM, payload);
    },
  };
}
