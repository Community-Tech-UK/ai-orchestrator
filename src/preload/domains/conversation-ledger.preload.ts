import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createConversationLedgerDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS
) {
  return {
    listConversations: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVERSATION_LEDGER_LIST, payload),

    getConversation: (threadId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVERSATION_LEDGER_GET, { threadId }),

    discoverConversations: (payload: unknown = {}): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVERSATION_LEDGER_DISCOVER, payload),

    reconcileConversation: (threadId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVERSATION_LEDGER_RECONCILE, { threadId }),

    startConversation: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVERSATION_LEDGER_START, payload),

    sendConversationTurn: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVERSATION_LEDGER_SEND_TURN, payload),
  };
}
