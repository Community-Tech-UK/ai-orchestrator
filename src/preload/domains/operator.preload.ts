import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createOperatorDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS
) {
  return {
    listOperatorRuns: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_LIST_RUNS, payload),

    getOperatorRun: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_GET_RUN, payload),

    cancelOperatorRun: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OPERATOR_CANCEL_RUN, payload),

    onOperatorEvent: (callback: (payload: unknown) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on(ch.OPERATOR_EVENT, listener);
      return () => ipcRenderer.removeListener(ch.OPERATOR_EVENT, listener);
    },
  };
}
