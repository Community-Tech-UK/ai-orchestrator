import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createGlobalPauseDomain(ipc: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    globalPauseGetState: (): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_GET_STATE),
    globalPauseHold: (payload: { reason?: string } = {}): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_HOLD, payload),
    globalPauseRelease: (): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_RELEASE),
    globalPauseRestart: (payload: { withNotes: boolean }): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_RESTART, payload),
    globalPauseSkipNotes: (): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_SKIP_NOTES),
    globalPauseResume: (): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_RESUME),
    globalPauseDiscard: (): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_DISCARD),
    globalPauseQuit: (): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_QUIT),
    globalPausePickUp: (payload: { instanceId: string }): Promise<IpcResponse> => ipc.invoke(ch.GLOBAL_PAUSE_PICK_UP, payload),
    onGlobalPauseStateChanged: (callback: (payload: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
      ipc.on(ch.GLOBAL_PAUSE_STATE_CHANGED, handler);
      return () => ipc.removeListener(ch.GLOBAL_PAUSE_STATE_CHANGED, handler);
    },
  };
}
