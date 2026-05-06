import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createAutomationDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    automationList: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_LIST),

    automationGet: (payload: { id: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_GET, payload),

    automationCreate: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_CREATE, payload),

    automationUpdate: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_UPDATE, payload),

    automationDelete: (payload: { id: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_DELETE, payload),

    automationRunNow: (payload: { id: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_RUN_NOW, payload),

    automationCancelPending: (payload: { id: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_CANCEL_PENDING, payload),

    automationListRuns: (payload?: { automationId?: string; limit?: number }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_LIST_RUNS, payload ?? {}),

    automationMarkSeen: (payload: { automationId?: string; runId?: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_MARK_SEEN, payload),

    automationPreflight: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_PREFLIGHT, payload),

    automationTemplatesList: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUTOMATION_TEMPLATES_LIST),

    onAutomationChanged: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.AUTOMATION_CHANGED, listener);
      return () => ipcRenderer.removeListener(ch.AUTOMATION_CHANGED, listener);
    },

    onAutomationRunChanged: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.AUTOMATION_RUN_CHANGED, listener);
      return () => ipcRenderer.removeListener(ch.AUTOMATION_RUN_CHANGED, listener);
    },
  };
}
