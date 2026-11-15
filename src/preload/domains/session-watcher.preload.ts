import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createSessionWatcherDomain(ipc: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    sessionWatcherListFlags: (): Promise<IpcResponse> => ipc.invoke(ch.SESSION_WATCHER_LIST_FLAGS),
    sessionWatcherAnswerYes: (payload: { instanceId: string; requestCount: number }): Promise<IpcResponse> =>
      ipc.invoke(ch.SESSION_WATCHER_ANSWER_YES, payload),
    sessionWatcherSetMuted: (payload: { instanceId: string; muted: boolean }): Promise<IpcResponse> =>
      ipc.invoke(ch.SESSION_WATCHER_SET_MUTED, payload),
    sessionWatcherTypingHold: (payload: { instanceId: string; untilMs: number }): Promise<IpcResponse> =>
      ipc.invoke(ch.SESSION_WATCHER_TYPING_HOLD, payload),
    onSessionWatcherFlagsChanged: (callback: (payload: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
      ipc.on(ch.SESSION_WATCHER_FLAGS_CHANGED, handler);
      return () => ipc.removeListener(ch.SESSION_WATCHER_FLAGS_CHANGED, handler);
    },
  };
}
