import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createPauseDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    pauseGetState: (): Promise<IpcResponse> => ipcRenderer.invoke(ch.PAUSE_GET_STATE),

    pauseSetManual: (payload: { paused: boolean }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PAUSE_SET_MANUAL, payload),

    pauseDetectorRecentEvents: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PAUSE_DETECTOR_RECENT_EVENTS),

    pauseDetectorResumeAfterError: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PAUSE_DETECTOR_RESUME_AFTER_ERROR),

    onPauseStateChanged: (callback: (payload: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on(ch.PAUSE_STATE_CHANGED, handler);
      return () => ipcRenderer.removeListener(ch.PAUSE_STATE_CHANGED, handler);
    },
  };
}
