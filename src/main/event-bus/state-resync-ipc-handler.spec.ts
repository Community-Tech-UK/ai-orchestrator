import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../automations', () => ({
  getAutomationStore: () => ({ listRuns: () => [] }),
}));

vi.mock('../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: () => ({ getActiveLoops: () => [] }),
}));

vi.mock('../pause/pause-coordinator', () => ({
  getPauseCoordinator: () => ({
    toPayload: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
  }),
}));

vi.mock('../state', () => ({
  getAppStore: () => ({
    getState: () => ({
      global: {
        memoryPressure: 'normal',
      },
    }),
  }),
}));

import { IPC_CHANNELS } from '@contracts/channels';
import { registerStateResyncHandler } from './state-resync-ipc-handler';

describe('registerStateResyncHandler', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers state:resync and returns a StateSyncSnapshot for authorized callers', async () => {
    registerStateResyncHandler({
      instanceManager: {
        getAllInstancesForIpc: () => [{ id: 'inst-1' }],
      },
      ensureAuthorized: () => null,
      getSeq: () => 99,
    });

    const handler = handlers.get(IPC_CHANNELS.STATE_RESYNC);
    expect(handler).toBeDefined();

    const response = await handler!({}, { ipcAuthToken: 'secret' });
    expect(response).toEqual({
      success: true,
      data: expect.objectContaining({
        instances: [{ id: 'inst-1' }],
        loopRuns: [],
        automationRuns: [],
        memoryPressure: 'normal',
        seq: 99,
      }),
    });
  });

  it('returns the authorization failure without building a snapshot', async () => {
    const authorizationFailure: IpcResponse = {
      success: false,
      error: {
        code: 'IPC_AUTH_FAILED',
        message: 'Missing token',
        timestamp: 1,
      },
    };
    const getAllInstancesForIpc = vi.fn(() => [{ id: 'inst-1' }]);
    registerStateResyncHandler({
      instanceManager: { getAllInstancesForIpc },
      ensureAuthorized: () => authorizationFailure,
      getSeq: () => 0,
    });

    const response = await handlers.get(IPC_CHANNELS.STATE_RESYNC)!({}, {});

    expect(response).toBe(authorizationFailure);
    expect(getAllInstancesForIpc).not.toHaveBeenCalled();
  });
});
