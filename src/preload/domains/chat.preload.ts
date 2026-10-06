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

    chatDelete: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHAT_DELETE, payload),

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

    // ── Session-linked sidechats ──────────────────────────────────────────

    sideChatCreate: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_CREATE, payload),

    sideChatList: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_LIST, payload),

    sideChatSend: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_SEND, payload),

    sideChatMarkRead: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_MARK_READ, payload),

    sideChatAttention: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_ATTENTION, payload),

    sideChatAttentionAll: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_ATTENTION_ALL),

    sideChatSetSelection: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_SET_SELECTION, payload),

    sideChatAttach: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_ATTACH, payload),

    sideChatPermissions: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.SIDE_CHAT_PERMISSIONS, payload),
  };
}
