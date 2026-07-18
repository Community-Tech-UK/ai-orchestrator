import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  ensureLocalStarted: vi.fn(),
  setLocalOverrideModel: vi.fn(),
  removeLocalOverrideModel: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/aio-test-user-data') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../providers/catalog-override-source', () => ({
  getCatalogOverrideSource: () => ({
    ensureLocalStarted: mocks.ensureLocalStarted,
    setLocalOverrideModel: mocks.setLocalOverrideModel,
    removeLocalOverrideModel: mocks.removeLocalOverrideModel,
  }),
}));

import { registerModelOverrideHandlers } from './model-override-ipc-handlers';

describe('model override IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerModelOverrideHandlers();
  });

  it('validates and writes a local model override', async () => {
    const entry = { provider: 'claude', id: 'opus-local' };
    mocks.setLocalOverrideModel.mockResolvedValue(entry);

    await expect(invoke(IPC_CHANNELS.MODEL_SET_OVERRIDE, {
      provider: 'claude',
      modelId: 'opus-local',
      config: { contextWindow: 200_000 },
    })).resolves.toEqual({ success: true, data: entry });

    expect(mocks.ensureLocalStarted).toHaveBeenCalledWith('/tmp/aio-test-user-data');
    expect(mocks.setLocalOverrideModel).toHaveBeenCalledWith(
      'claude',
      'opus-local',
      { contextWindow: 200_000 },
    );
  });

  it('rejects invalid override payloads before starting persistence', async () => {
    const result = await invoke(IPC_CHANNELS.MODEL_REMOVE_OVERRIDE, { modelId: '' });

    expect(result).toMatchObject({
      success: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    });
    expect(mocks.ensureLocalStarted).not.toHaveBeenCalled();
    expect(mocks.removeLocalOverrideModel).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender before writing overrides', async () => {
    const trustError = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerModelOverrideHandlers({ ensureTrustedSender });

    await expect(invoke(IPC_CHANNELS.MODEL_SET_OVERRIDE, {
      provider: 'claude',
      modelId: 'opus-local',
    })).resolves.toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.MODEL_SET_OVERRIDE);
    expect(mocks.ensureLocalStarted).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
