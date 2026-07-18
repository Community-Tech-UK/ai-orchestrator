import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  store: {
    getStats: vi.fn(),
    getReflections: vi.fn((): unknown[] => []),
    getObservations: vi.fn((): unknown[] => []),
    configure: vi.fn(),
    getConfig: vi.fn(),
    applyDecay: vi.fn(),
  },
  ingestor: {
    configure: vi.fn(),
    forceFlush: vi.fn(),
  },
  reflector: {
    forceReflect: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../observation/observation-store', () => ({
  getObservationStore: () => mocks.store,
}));

vi.mock('../observation/observation-ingestor', () => ({
  getObservationIngestor: () => mocks.ingestor,
}));

vi.mock('../observation/reflector-agent', () => ({
  getReflectorAgent: () => mocks.reflector,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

import { registerObservationHandlers } from './observation-ipc-handler';

const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];

describe('registerObservationHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.store.getStats.mockReturnValue({ observations: 2 });
    mocks.store.getConfig.mockReturnValue({ enabled: true });
    mocks.store.applyDecay.mockReturnValue({ removed: 1 });
    registerObservationHandlers();
  });

  it('returns IpcResponse envelopes for all observation operations', async () => {
    await expect(invoke(IPC_CHANNELS.OBSERVATION_GET_STATS)).resolves.toEqual({
      success: true,
      data: { observations: 2 },
    });
    await expect(invoke(IPC_CHANNELS.OBSERVATION_GET_REFLECTIONS, { limit: 5 }))
      .resolves.toEqual({ success: true, data: [] });
    await expect(invoke(IPC_CHANNELS.OBSERVATION_GET_OBSERVATIONS, { limit: 5 }))
      .resolves.toEqual({ success: true, data: [] });
    await expect(invoke(IPC_CHANNELS.OBSERVATION_CONFIGURE, { enabled: false }))
      .resolves.toEqual({ success: true });
    await expect(invoke(IPC_CHANNELS.OBSERVATION_GET_CONFIG)).resolves.toEqual({
      success: true,
      data: { enabled: true },
    });
    await expect(invoke(IPC_CHANNELS.OBSERVATION_FORCE_REFLECT))
      .resolves.toEqual({ success: true });
    await expect(invoke(IPC_CHANNELS.OBSERVATION_CLEANUP)).resolves.toEqual({
      success: true,
      data: { removed: 1 },
    });
  });

  it('returns structured validation errors without mutating observation state', async () => {
    const result = await invoke(IPC_CHANNELS.OBSERVATION_CONFIGURE, {
      decayRate: 2,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.objectContaining({
        code: 'VALIDATION_FAILED',
        timestamp: expect.any(Number),
      }),
    });
    expect(mocks.store.configure).not.toHaveBeenCalled();
    expect(mocks.ingestor.configure).not.toHaveBeenCalled();
  });

  it('returns a stable structured error when an observation operation fails', async () => {
    mocks.store.getStats.mockImplementation(() => {
      throw new Error('observation database unavailable');
    });

    await expect(invoke(IPC_CHANNELS.OBSERVATION_GET_STATS)).resolves.toMatchObject({
      success: false,
      error: {
        code: 'OBSERVATION_GET_STATS_FAILED',
        message: 'observation database unavailable',
        timestamp: expect.any(Number),
      },
    });
  });

  it('rejects an untrusted sender before forcing reflection', async () => {
    mocks.handlers.clear();
    const trustError = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerObservationHandlers({ ensureTrustedSender });

    await expect(invoke(IPC_CHANNELS.OBSERVATION_FORCE_REFLECT)).resolves.toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith(
      fakeEvent,
      IPC_CHANNELS.OBSERVATION_FORCE_REFLECT,
    );
    expect(mocks.ingestor.forceFlush).not.toHaveBeenCalled();
    expect(mocks.reflector.forceReflect).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(fakeEvent, payload);
}
