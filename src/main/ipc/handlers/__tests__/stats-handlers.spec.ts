import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const statsManagerMocks = vi.hoisted(() => ({
  recordSessionStart: vi.fn(),
  recordSessionEnd: vi.fn(),
  recordMessage: vi.fn(),
  recordToolUsage: vi.fn(),
  getStats: vi.fn(() => ({ period: 'week', totalSessions: 7 })),
  getSessionStats: vi.fn(),
  getActiveSessions: vi.fn(() => []),
  getToolUsage: vi.fn(() => []),
  exportStats: vi.fn(),
  clearStats: vi.fn(),
  getStorageUsage: vi.fn(() => ({ bytes: 0 })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../core/system/usage-stats', () => ({
  getUsageStatsManager: () => statsManagerMocks,
}));

import { registerStatsHandlers } from '../stats-handlers';

describe('stats-handlers renderer-facing aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.handlers.clear();
    registerStatsHandlers();
  });

  it('handles STATS_GET_STATS by delegating to the canonical stats manager query', async () => {
    const result = await invoke(IPC_CHANNELS.STATS_GET_STATS, { period: 'year' });

    expect(result).toMatchObject({
      success: true,
      data: { period: 'week', totalSessions: 7 },
    });
    expect(statsManagerMocks.getStats).toHaveBeenCalledWith('year');
  });
});

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
