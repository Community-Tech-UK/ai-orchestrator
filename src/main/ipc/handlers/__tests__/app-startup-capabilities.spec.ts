import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

const capabilityProbe = vi.hoisted(() => ({
  getLastReport: vi.fn(),
  run: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../bootstrap/capability-probe', () => ({
  getCapabilityProbe: () => capabilityProbe,
}));

import { registerAppHandlers } from '../app-handlers';

function getHandler(channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing handler for ${channel}`);
  }
  return handler;
}

describe('registerAppHandlers startup capabilities', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('pushes startup capabilities to the renderer during APP_READY', async () => {
    const report = {
      status: 'degraded',
      generatedAt: Date.now(),
      checks: [{ id: 'provider.any', label: 'Provider availability', category: 'provider', status: 'unavailable', critical: true, summary: 'No providers available.' }],
    };
    capabilityProbe.getLastReport.mockReturnValue(report);

    registerAppHandlers({
      windowManager: {} as never,
      getIpcAuthToken: () => 'ipc-auth-token',
    });

    const sender = { send: vi.fn() };
    const response = await getHandler(IPC_CHANNELS.APP_READY)({ sender });

    expect(response.success).toBe(true);
    expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.APP_STARTUP_CAPABILITIES, report);
  });

  it('returns the startup capability report via APP_GET_STARTUP_CAPABILITIES', async () => {
    const report = {
      status: 'ready',
      generatedAt: Date.now(),
      checks: [],
    };
    capabilityProbe.getLastReport.mockReturnValue(report);

    registerAppHandlers({
      windowManager: {} as never,
      getIpcAuthToken: () => 'ipc-auth-token',
    });

    const response = await getHandler(IPC_CHANNELS.APP_GET_STARTUP_CAPABILITIES)({});

    expect(response).toEqual({
      success: true,
      data: report,
    });
  });
});
