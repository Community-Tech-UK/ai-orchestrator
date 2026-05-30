import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export interface TerminalSpawnInput {
  /** Worker node to run the terminal on. Required — remote terminals only. */
  nodeId: string;
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

/**
 * Remote terminal IPC surface (Piece C). Mirrors the loop domain's shape:
 * `invoke` for request/response, `sub(...)` for main → renderer event streams.
 */
export function createTerminalDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  const sub = (channel: string) => (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };

  return {
    terminalSpawn: (input: TerminalSpawnInput): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.TERMINAL_SPAWN, input),
    terminalWrite: (sessionId: string, data: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.TERMINAL_WRITE, { sessionId, data }),
    terminalResize: (sessionId: string, cols: number, rows: number): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.TERMINAL_RESIZE, { sessionId, cols, rows }),
    terminalKill: (sessionId: string, signal?: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.TERMINAL_KILL, { sessionId, signal }),

    onTerminalOutput: sub(ch.TERMINAL_OUTPUT),
    onTerminalExit: sub(ch.TERMINAL_EXIT),
    onTerminalSpawned: sub(ch.TERMINAL_SPAWNED),
  };
}
