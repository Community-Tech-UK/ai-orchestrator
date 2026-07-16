/**
 * IPC handlers for the remote terminal (Piece C).
 *
 * Bridges the renderer to {@link RemoteTerminalManager}:
 *  - `ipcMain.handle` for spawn/write/resize/kill (renderer → main → worker RPC)
 *  - forwards the manager's `output` / `exit` / `spawned` EventEmitter events to
 *    the renderer via `WindowManager.sendToRenderer` (main → renderer).
 *
 * Scope: REMOTE terminals only — every spawn requires a `nodeId`. Local
 * terminals are intentionally unsupported here (they'd need node-pty inside the
 * Electron main process); the renderer surfaces a "pick a worker" message.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getRemoteTerminalManager } from '../../remote-node/remote-terminal-manager';
import type { WindowManager } from '../../window-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('TerminalHandlers');

const DIMENSION = z.number().int().positive().max(2000);

const TerminalSpawnSchema = z.object({
  nodeId: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: DIMENSION.optional(),
  rows: DIMENSION.optional(),
});

const TerminalWriteSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

const TerminalResizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: DIMENSION,
  rows: DIMENSION,
});

const TerminalKillSchema = z.object({
  sessionId: z.string().min(1),
  signal: z.string().optional(),
});

const TerminalGetBufferSchema = z.object({
  sessionId: z.string().min(1),
});

function errorResponse(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

/**
 * Module-level handle to the currently-attached event bridge so re-registration
 * (tests, hot reload) detaches the previous listeners instead of stacking them.
 */
let attachedBridge: {
  output: (e: unknown) => void;
  exit: (e: unknown) => void;
  spawned: (e: unknown) => void;
} | null = null;

export function registerTerminalHandlers(deps: { windowManager: WindowManager }): void {
  const manager = getRemoteTerminalManager();

  // ── one-time-ish event bridge: manager → renderer ──
  if (attachedBridge) {
    manager.off('output', attachedBridge.output);
    manager.off('exit', attachedBridge.exit);
    manager.off('spawned', attachedBridge.spawned);
  }
  const bridge = {
    output: (e: unknown) => deps.windowManager.sendToRenderer(IPC_CHANNELS.TERMINAL_OUTPUT, e),
    exit: (e: unknown) => deps.windowManager.sendToRenderer(IPC_CHANNELS.TERMINAL_EXIT, e),
    spawned: (e: unknown) => deps.windowManager.sendToRenderer(IPC_CHANNELS.TERMINAL_SPAWNED, e),
  };
  manager.on('output', bridge.output);
  manager.on('exit', bridge.exit);
  manager.on('spawned', bridge.spawned);
  attachedBridge = bridge;

  ipcMain.handle(IPC_CHANNELS.TERMINAL_SPAWN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const req = TerminalSpawnSchema.parse(payload);
      const result = await manager.spawn(req);
      return { success: true, data: result };
    } catch (error) {
      return errorResponse('TERMINAL_SPAWN_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_WRITE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { sessionId, data } = TerminalWriteSchema.parse(payload);
      await manager.write(sessionId, data);
      return { success: true };
    } catch (error) {
      return errorResponse('TERMINAL_WRITE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { sessionId, cols, rows } = TerminalResizeSchema.parse(payload);
      await manager.resize(sessionId, cols, rows);
      return { success: true };
    } catch (error) {
      return errorResponse('TERMINAL_RESIZE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_KILL, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { sessionId, signal } = TerminalKillSchema.parse(payload);
      await manager.kill(sessionId, signal);
      return { success: true };
    } catch (error) {
      return errorResponse('TERMINAL_KILL_FAILED', error);
    }
  });

  // WS11.7: retained scrollback so a re-attaching renderer replays recent
  // output instead of starting blank. `data: null` = unknown/exited session.
  ipcMain.handle(IPC_CHANNELS.TERMINAL_GET_BUFFER, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { sessionId } = TerminalGetBufferSchema.parse(payload);
      return { success: true, data: { output: manager.getBufferedOutput(sessionId) } };
    } catch (error) {
      return errorResponse('TERMINAL_GET_BUFFER_FAILED', error);
    }
  });

  logger.info('Terminal IPC handlers registered');
}
