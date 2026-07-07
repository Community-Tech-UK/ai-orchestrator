import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const logManagerMocks = vi.hoisted(() => ({
  getRecentLogs: vi.fn(() => [{ message: 'hello' }]),
  getConfig: vi.fn(() => ({ globalLevel: 'info' })),
  setGlobalLevel: vi.fn(),
  setSubsystemLevel: vi.fn(),
  clearBuffer: vi.fn(),
  exportLogs: vi.fn(),
  getSubsystems: vi.fn(() => ['test']),
  getLogFilePaths: vi.fn(() => ['/tmp/app.log']),
}));

const debugManagerMocks = vi.hoisted(() => ({
  debugAgent: vi.fn(async () => ({ target: 'agent', success: true })),
  debugConfig: vi.fn(async () => ({ target: 'config', success: true })),
  debugFile: vi.fn(async () => ({ target: 'file', success: true })),
  debugMemory: vi.fn(() => ({ target: 'memory', success: true })),
  debugSystem: vi.fn(() => ({ target: 'system', success: true })),
  debugProcess: vi.fn(() => ({ target: 'process', success: true })),
  debugAll: vi.fn(async () => ({ system: { target: 'system', success: true } })),
  getMemoryHistory: vi.fn(() => []),
  clearMemoryHistory: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogManager: () => logManagerMocks,
}));

vi.mock('../../../core/system/debug-commands', () => ({
  getDebugCommandsManager: () => debugManagerMocks,
}));

import { registerDebugHandlers } from '../debug-handlers';

describe('debug-handlers renderer-facing aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.handlers.clear();
    registerDebugHandlers();
  });

  it('handles LOG_GET_LOGS by delegating to recent log retrieval', async () => {
    const result = await invoke(IPC_CHANNELS.LOG_GET_LOGS, {
      options: { level: 'warn', limit: 10 },
    });

    expect(result).toMatchObject({ success: true, data: [{ message: 'hello' }] });
    expect(logManagerMocks.getRecentLogs).toHaveBeenCalledWith({
      level: 'warn',
      limit: 10,
      subsystem: undefined,
      startTime: undefined,
      endTime: undefined,
    });
  });

  it('registers debug command discovery and diagnostic handlers used by the renderer', async () => {
    await expect(invoke(IPC_CHANNELS.DEBUG_GET_COMMANDS)).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([expect.objectContaining({ id: 'system' })]),
    });
    await expect(invoke(IPC_CHANNELS.DEBUG_GET_INFO)).resolves.toMatchObject({
      success: true,
      data: expect.objectContaining({ commands: expect.any(Array) }),
    });
    await expect(invoke(IPC_CHANNELS.DEBUG_RUN_DIAGNOSTICS)).resolves.toMatchObject({
      success: true,
      data: { system: { target: 'system', success: true } },
    });

    expect(debugManagerMocks.debugAll).toHaveBeenCalledTimes(1);
  });

  it('executes renderer-requested debug commands and clears the log buffer alias', async () => {
    await expect(invoke(IPC_CHANNELS.DEBUG_EXECUTE, {
      command: 'system',
      args: {},
    })).resolves.toMatchObject({
      success: true,
      data: { target: 'system', success: true },
    });
    await expect(invoke(IPC_CHANNELS.LOG_CLEAR)).resolves.toMatchObject({ success: true });

    expect(debugManagerMocks.debugSystem).toHaveBeenCalledTimes(1);
    expect(logManagerMocks.clearBuffer).toHaveBeenCalledTimes(1);
  });
});

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
