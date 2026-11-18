import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type {
  PlanQueueControlPayload,
  PlanQueueKind,
  PlanQueueLinearConfirmPayload,
  PlanQueueLinearIdentifyPayload,
  PlanQueueLinearLinksSavePayload,
  PlanQueueLinearPreviewLoadPayload,
  PlanQueueLinearPreviewTextPayload,
  PlanQueueLinearTeamsSavePayload,
  PlanQueuePreviewPayload,
  PlanQueueRouteChoice,
  PlanQueueTicketAskAnswerPayload,
  PlanQueueTicketAskReadPayload,
} from '@contracts/schemas/plan-queue';

export function createPlanQueueDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    planQueuePreview: (payload: PlanQueuePreviewPayload): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_PREVIEW, payload),
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
      config?: { keepOnThisMac?: boolean };
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_START, payload),

    planQueueStartSetAsideAgent: (payload: { workspaceCwd: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_START_SET_ASIDE_AGENT, payload),

    /** Live-test copies only; every other app refuses. See plan-queue-livetest-fixture.ts. */
    planQueueLiveTestFixtureStart: (payload: {
      parentInstanceId: string;
      routing: { workers: PlanQueueRouteChoice[]; verifiers: PlanQueueRouteChoice[]; stepUp?: PlanQueueRouteChoice };
      workload?: 'small' | 'long';
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LIVETEST_FIXTURE_START, payload),

    planQueueLiveTestFixtureRemove: (payload: { fixtureId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LIVETEST_FIXTURE_REMOVE, payload),

    planQueueLiveTestFixtureList: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LIVETEST_FIXTURE_LIST, {}),

    planQueueAnswer: (payload: { itemId: string; optionId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_ANSWER, payload),

    planQueueControl: (payload: PlanQueueControlPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_CONTROL, payload),

    planQueueLinearList: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_LIST, {}),

    planQueueLinearIdentify: (payload: PlanQueueLinearIdentifyPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_IDENTIFY, payload),

    planQueueLinearConfirm: (payload: PlanQueueLinearConfirmPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_CONFIRM, payload),

    planQueueLinearForget: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_FORGET, {}),

    planQueueLinearCheck: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_CHECK, {}),

    planQueueLinearProjects: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_PROJECTS, {}),

    planQueueLinearLinks: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_LINKS, {}),

    planQueueLinearLinksSave: (payload: PlanQueueLinearLinksSavePayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_LINKS_SAVE, payload),

    planQueueLinearTeamChoices: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_TEAM_CHOICES, {}),

    planQueueLinearTeamsCheck: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_TEAMS_CHECK, {}),

    planQueueLinearPreviewLoad: (payload: PlanQueueLinearPreviewLoadPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_PREVIEW_LOAD, payload),

    planQueueLinearPreviewText: (payload: PlanQueueLinearPreviewTextPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_PREVIEW_TEXT, payload),

    planQueueTicketAskRead: (payload: PlanQueueTicketAskReadPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_TICKET_ASK_READ, payload),

    planQueueTicketAskAnswer: (payload: PlanQueueTicketAskAnswerPayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_TICKET_ASK_ANSWER, payload),

    planQueueLinearTeamsSave: (payload: PlanQueueLinearTeamsSavePayload): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PLAN_QUEUE_LINEAR_TEAMS_SAVE, payload),

    onPlanQueueStateChanged: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.PLAN_QUEUE_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(ch.PLAN_QUEUE_STATE_CHANGED, listener);
    },
  };
}
