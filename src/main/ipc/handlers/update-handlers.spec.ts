import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../../shared/types/update.types';

type Handler = () => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  cleanup: null as (() => void) | null,
  handlers: new Map<string, Handler>(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.0' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
    removeHandler: mocks.removeHandler,
  },
}));

class FakeService extends EventEmitter {
  initialize = vi.fn();
  dispose = vi.fn();
  checkForUpdates = vi.fn(async (): Promise<UpdateStatus> => STATUS);
  downloadUpdate = vi.fn(async (): Promise<UpdateStatus> => ({ ...STATUS, state: 'downloading' }));
  quitAndInstall = vi.fn(() => true);
  getStatus = vi.fn((): UpdateStatus => STATUS);
}

const STATUS: UpdateStatus = {
  state: 'idle',
  enabled: true,
  currentVersion: '0.1.0',
};
const service = new FakeService();

vi.mock('../../updates/auto-update-service', () => ({
  getAutoUpdateService: () => service,
}));

vi.mock('../../util/cleanup-registry', () => ({
  registerCleanup: vi.fn((cleanup: () => void) => {
    mocks.cleanup = cleanup;
    return vi.fn();
  }),
}));

import { registerUpdateHandlers } from './update-handlers';

describe('registerUpdateHandlers', () => {
  const windowManager = { sendToRenderer: vi.fn() };

  beforeEach(() => {
    service.removeAllListeners();
    mocks.cleanup = null;
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mocks.cleanup?.();
  });

  it('enables silent downloads only for packaged applications', () => {
    registerUpdateHandlers({ windowManager: windowManager as never });

    expect(service.initialize).toHaveBeenCalledWith({
      enabled: true,
      autoDownload: true,
      currentVersion: '0.1.0',
    });
  });

  it('broadcasts status changes and removes the listener during cleanup', () => {
    registerUpdateHandlers({ windowManager: windowManager as never });

    service.emit('status', { ...STATUS, state: 'downloaded' });
    expect(windowManager.sendToRenderer).toHaveBeenCalledOnce();

    expect(mocks.cleanup).not.toBeNull();
    mocks.cleanup?.();
    service.emit('status', { ...STATUS, state: 'error' });

    expect(windowManager.sendToRenderer).toHaveBeenCalledOnce();
    expect(service.dispose).toHaveBeenCalledOnce();
  });

  it('returns typed service results from every update handler', async () => {
    registerUpdateHandlers({ windowManager: windowManager as never });

    await expect(invoke('update:get-status')).resolves.toEqual({ success: true, data: STATUS });
    await expect(invoke('update:check')).resolves.toEqual({ success: true, data: STATUS });
    await expect(invoke('update:download')).resolves.toMatchObject({
      success: true,
      data: { state: 'downloading' },
    });
    await expect(invoke('update:install')).resolves.toEqual({
      success: true,
      data: { installing: true },
    });
  });
});

function invoke(channel: string): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler();
}
