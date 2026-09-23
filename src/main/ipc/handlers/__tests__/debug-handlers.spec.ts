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

  it('accepts every LOG_GET_LOGS shape the preload sends', async () => {
    // Logs page with "all" levels: preload wraps undefined options.
    await expect(invoke(IPC_CHANNELS.LOG_GET_LOGS, { options: undefined })).resolves.toMatchObject({ success: true });
    await expect(invoke(IPC_CHANNELS.LOG_GET_LOGS)).resolves.toMatchObject({ success: true });
    // `context` is the preload's name for subsystem; root-level options still work.
    await invoke(IPC_CHANNELS.LOG_GET_LOGS, { context: 'IPC', limit: 20_000 });

    expect(logManagerMocks.getRecentLogs).toHaveBeenLastCalledWith({
      level: undefined,
      subsystem: 'IPC',
      startTime: undefined,
      endTime: undefined,
      limit: 20_000,
    });
  });

  it.each([
    ['a non-object payload', 'warn'],
    ['an unknown level', { options: { level: 'verbose' } }],
    ['a non-numeric limit', { options: { limit: '10' } }],
    ['a zero limit', { options: { limit: 0 } }],
    ['a negative startTime', { options: { startTime: -1 } }],
  ])('rejects LOG_GET_LOGS with %s', async (_label, payload) => {
    const result = await invoke(IPC_CHANNELS.LOG_GET_LOGS, payload);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LOG_GET_LOGS_FAILED');
    expect(result.error?.message).toContain('IPC validation failed for LOG_GET_LOGS');
    expect(logManagerMocks.getRecentLogs).not.toHaveBeenCalled();
  });

  it('passes validated DEBUG_EXECUTE args through to the command', async () => {
    await expect(invoke(IPC_CHANNELS.DEBUG_EXECUTE, {
      command: 'file',
      args: { filePath: '/tmp/a.txt' },
    })).resolves.toMatchObject({ success: true });
    // The Logs page sends no args at all.
    await expect(invoke(IPC_CHANNELS.DEBUG_EXECUTE, { command: 'memory' })).resolves.toMatchObject({ success: true });

    expect(debugManagerMocks.debugFile).toHaveBeenCalledWith('/tmp/a.txt');
    expect(debugManagerMocks.debugMemory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing payload', undefined],
    ['a missing command', { args: {} }],
    ['an unknown command', { command: 'rm-rf' }],
    ['a non-string file path', { command: 'file', args: { filePath: 42 } }],
  ])('rejects DEBUG_EXECUTE with %s before running anything', async (_label, payload) => {
    const result = await invoke(IPC_CHANNELS.DEBUG_EXECUTE, payload);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DEBUG_EXECUTE_FAILED');
    expect(result.error?.message).toContain('IPC validation failed for DEBUG_EXECUTE');
    for (const fn of Object.values(debugManagerMocks)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
