import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export interface RtkSummaryRequest {
  projectPath?: string;
  sinceMs?: number;
  topN?: number;
}

export interface RtkHistoryRequest {
  projectPath?: string;
  limit?: number;
}

export function createRtkDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    rtkGetStatus: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.RTK_GET_STATUS, {}),

    rtkGetSummary: (payload?: RtkSummaryRequest): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RTK_GET_SUMMARY, payload ?? {}),

    rtkGetHistory: (payload?: RtkHistoryRequest): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RTK_GET_HISTORY, payload ?? {}),
  };
}
