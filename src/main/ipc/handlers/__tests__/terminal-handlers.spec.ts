import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { registerTerminalHandlers } from '../terminal-handlers';
import { getRemoteTerminalManager } from '../../../remote-node/remote-terminal-manager';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../remote-node/remote-terminal-manager', () => {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  const mgr = {
    on(ev: string, cb: (p: unknown) => void) { (listeners[ev] ||= []).push(cb); return mgr; },
    off(ev: string, cb: (p: unknown) => void) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); return mgr; },
    emit(ev: string, p: unknown) { (listeners[ev] || []).forEach((f) => f(p)); return true; },
    spawn: vi.fn(async () => ({ sessionId: 's1', pid: 7, nodeId: 'n1' })),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
  };
  return { getRemoteTerminalManager: () => mgr };
});

type HandlerFn = (
  event: unknown,
  payload: unknown,
) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;

function handlerFor(channel: string): HandlerFn {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as unknown as HandlerFn;
}

describe('registerTerminalHandlers', () => {
  let windowManager: { sendToRenderer: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    windowManager = { sendToRenderer: vi.fn() };
    registerTerminalHandlers({ windowManager: windowManager as never });
  });

  it('registers invoke handlers for spawn/write/resize/kill', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch);
    expect(channels).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.TERMINAL_SPAWN,
        IPC_CHANNELS.TERMINAL_WRITE,
        IPC_CHANNELS.TERMINAL_RESIZE,
        IPC_CHANNELS.TERMINAL_KILL,
      ]),
    );
  });

  it('spawns via the manager and returns the session', async () => {
    const res = await handlerFor(IPC_CHANNELS.TERMINAL_SPAWN)({}, { nodeId: 'n1', cwd: '/work' });
    expect(getRemoteTerminalManager().spawn).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'n1', cwd: '/work' }),
    );
    expect(res).toEqual({ success: true, data: { sessionId: 's1', pid: 7, nodeId: 'n1' } });
  });

  it('rejects an invalid spawn payload (missing nodeId)', async () => {
    const res = await handlerFor(IPC_CHANNELS.TERMINAL_SPAWN)({}, { cwd: '/work' });
    expect(res.success).toBe(false);
    expect(res.error?.message).toBeTruthy();
  });

  it('bridges manager output events to the renderer', () => {
    getRemoteTerminalManager().emit('output', { sessionId: 's1', data: 'hello' });
    expect(windowManager.sendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.TERMINAL_OUTPUT,
      { sessionId: 's1', data: 'hello' },
    );
  });
});
