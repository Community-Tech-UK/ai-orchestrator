import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  installIpcHandlerTiming,
  _resetIpcHandlerTimingForTesting,
} from '../ipc-handler-timing';
import { setSlowOpCallback } from '../../util/slow-operations';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function makeFakeIpcMain(): { ipcMain: IpcMain; invoke: (channel: string, ...args: unknown[]) => unknown } {
  const handlers = new Map<string, Listener>();
  const ipcMain = {
    handle(channel: string, listener: Listener): void {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const listener = handlers.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return listener({} as IpcMainInvokeEvent, ...args);
  };
  return { ipcMain, invoke };
}

function busyWaitMs(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // Deliberately block synchronously to simulate a stalling handler prelude.
  }
}

describe('installIpcHandlerTiming', () => {
  beforeEach(() => {
    _resetIpcHandlerTimingForTesting();
  });

  afterEach(() => {
    setSlowOpCallback(null);
    _resetIpcHandlerTimingForTesting();
  });

  it('reports a slow synchronous prelude through the slow-op callback', async () => {
    const slowOps: { name: string }[] = [];
    setSlowOpCallback((name) => slowOps.push({ name }));

    const { ipcMain, invoke } = makeFakeIpcMain();
    installIpcHandlerTiming(ipcMain, { blockWarnMs: 50 });

    ipcMain.handle('slow:channel', async () => {
      busyWaitMs(120); // synchronous prelude well past the 50ms threshold
      return 'ok';
    });

    const result = await invoke('slow:channel');
    expect(result).toBe('ok');
    expect(slowOps.some((op) => op.name === 'ipc:slow:channel')).toBe(true);
  });

  it('does not report a fast handler', async () => {
    const slowOps: string[] = [];
    setSlowOpCallback((name) => slowOps.push(name));

    const { ipcMain, invoke } = makeFakeIpcMain();
    installIpcHandlerTiming(ipcMain, { blockWarnMs: 50 });

    ipcMain.handle('fast:channel', async () => 'ok');

    await invoke('fast:channel');
    expect(slowOps).not.toContain('ipc:fast:channel');
  });

  it('preserves the handler return value and arguments', async () => {
    const { ipcMain, invoke } = makeFakeIpcMain();
    installIpcHandlerTiming(ipcMain, { blockWarnMs: 50 });

    ipcMain.handle('echo:channel', async (_event, a, b) => ({ a, b }));

    const result = await invoke('echo:channel', 1, 'two');
    expect(result).toEqual({ a: 1, b: 'two' });
  });

  it('is idempotent — installing twice does not double-wrap', () => {
    const { ipcMain } = makeFakeIpcMain();
    const first = ipcMain.handle;
    installIpcHandlerTiming(ipcMain, { blockWarnMs: 50 });
    const wrapped = ipcMain.handle;
    installIpcHandlerTiming(ipcMain, { blockWarnMs: 50 });
    expect(ipcMain.handle).toBe(wrapped);
    expect(ipcMain.handle).not.toBe(first);
  });
});
