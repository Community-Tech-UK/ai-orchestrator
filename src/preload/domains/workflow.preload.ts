import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createWorkflowDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    workflowCanTransition: (payload: {
      instanceId: string;
      templateId: string;
      source: 'slash-command' | 'nl-suggestion' | 'automation' | 'manual-ui' | 'restore';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_CAN_TRANSITION, payload);
    },

    workflowNlSuggest: (payload: {
      promptText: string;
      provider?: string;
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_NL_SUGGEST, payload);
    },
  };
}
