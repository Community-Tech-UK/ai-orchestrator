import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createOperatorDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS
) {
  return {
    operatorGetThread: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_GET_THREAD, payload),

    operatorSendMessage: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_SEND_MESSAGE, payload),

    operatorListRuns: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_LIST_RUNS, payload),

    operatorGetRun: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_GET_RUN, payload),

    operatorCancelRun: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_CANCEL_RUN, payload),

    operatorRetryRun: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_RETRY_RUN, payload),

    operatorListProjects: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_LIST_PROJECTS, payload),

    operatorRescanProjects: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_RESCAN_PROJECTS, payload),

    onOperatorEvent: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.OPERATOR_EVENT, handler);
      return () => ipcRenderer.removeListener(ch.OPERATOR_EVENT, handler);
    },
  };
}
