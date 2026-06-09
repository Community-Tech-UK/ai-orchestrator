import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createChatDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    chatList: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_LIST, payload),

    chatGet: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_GET, payload),

    chatCreate: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_CREATE, payload),

    chatRename: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_RENAME, payload),

    chatArchive: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_ARCHIVE, payload),

    chatSetCwd: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_SET_CWD, payload),

    chatSetProvider: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_SET_PROVIDER, payload),

    chatSetModel: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_SET_MODEL, payload),

    chatSetReasoning: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_SET_REASONING, payload),

    chatSetYolo: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_SET_YOLO, payload),

    chatLoadOlderMessages: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_LOAD_OLDER_MESSAGES, payload),

    chatSendMessage: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_SEND_MESSAGE, payload),

    chatGetUiState: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_UI_STATE_GET, {}),

    chatSetUiState: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_UI_STATE_SET, payload),

    onChatEvent: (callback: (payload: unknown) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on(ch.CHAT_EVENT, listener);
      return () => ipcRenderer.removeListener(ch.CHAT_EVENT, listener);
    },
  };
}
