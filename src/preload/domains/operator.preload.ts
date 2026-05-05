import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createOperatorDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS
) {
  return {
    getOperatorThread: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_GET_THREAD, payload),

    sendOperatorMessage: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_SEND_MESSAGE, payload),

    listOperatorProjects: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_LIST_PROJECTS, payload),

    rescanOperatorProjects: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_RESCAN_PROJECTS, payload),

    listOperatorRuns: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_LIST_RUNS, payload),

    getOperatorRun: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_GET_RUN, payload),
  };
}
