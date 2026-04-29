import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type {
  PromptHistoryDelta,
  PromptHistoryEntry,
} from '../../shared/types/prompt-history.types';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createPromptHistoryDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    promptHistoryGetSnapshot: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PROMPT_HISTORY_GET_SNAPSHOT, {});
    },

    promptHistoryRecord: (payload: {
      instanceId: string;
      entry: PromptHistoryEntry;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PROMPT_HISTORY_RECORD, payload);
    },

    promptHistoryClearInstance: (payload: {
      instanceId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PROMPT_HISTORY_CLEAR_INSTANCE, payload);
    },

    onPromptHistoryDelta: (callback: (delta: PromptHistoryDelta) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, delta: PromptHistoryDelta) => callback(delta);
      ipcRenderer.on(ch.PROMPT_HISTORY_DELTA, listener);
      return () => ipcRenderer.removeListener(ch.PROMPT_HISTORY_DELTA, listener);
    },
  };
}
