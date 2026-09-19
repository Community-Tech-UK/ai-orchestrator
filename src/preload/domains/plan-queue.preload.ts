import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { PlanQueueControlPayload, PlanQueueKind } from '@contracts/schemas/plan-queue';

export function createPlanQueueDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    planQueueList: (payload?: { limit?: number }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LIST, payload ?? {}),

    planQueueGet: (payload: { runId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_GET, payload),

    planQueueAlerts: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_ALERTS, {}),

    planQueueDiffstat: (payload: { itemId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_DIFFSTAT, payload),

    planQueueStart: (payload: {
      parentInstanceId: string;
      kind: PlanQueueKind;
      workspaceCwd: string;
      glob?: string;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_START, payload),

    planQueueAnswer: (payload: { itemId: string; optionId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_ANSWER, payload),

    planQueueControl: (payload: PlanQueueControlPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_CONTROL, payload),

    onPlanQueueStateChanged: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.PLAN_QUEUE_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(ch.PLAN_QUEUE_STATE_CHANGED, listener);
    },
  };
}
