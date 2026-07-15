import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = () => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  removeHandler: vi.fn(),
  cleanup: null as (() => void) | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
    removeHandler: mocks.removeHandler,
  },
}));

vi.mock('../../util/cleanup-registry', () => ({
  registerCleanup: vi.fn((cleanup: () => void) => {
    mocks.cleanup = cleanup;
    return vi.fn();
  }),
}));

import { registerNotificationHandlers } from './notification-handlers';

describe('registerNotificationHandlers', () => {
  let emit: ((record: unknown) => void) | null;
  const records = [{
    id: 'notification-1',
    kind: 'agent-finished',
    title: 'Finished',
    body: 'One',
    urgency: 'normal',
    fingerprint: 'fingerprint',
    createdAt: 1,
    delivery: 'desktop',
  }];
  const service = {
    list: vi.fn(() => records),
    subscribe: vi.fn((listener: (record: unknown) => void) => {
      emit = listener;
      return () => {
        emit = null;
      };
    }),
  };
  const windowManager = { sendToRenderer: vi.fn() };

  beforeEach(() => {
    emit = null;
    mocks.handlers.clear();
    mocks.cleanup = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    mocks.cleanup?.();
  });

  it('serves a snapshot and forwards resolved notification deltas to the renderer', async () => {
    registerNotificationHandlers({
      notificationService: service as never,
      windowManager: windowManager as never,
    });

    await expect(invoke('notification:list')).resolves.toEqual({ success: true, data: records });

    emit?.(records[0]);
    expect(windowManager.sendToRenderer).toHaveBeenCalledWith('notification:delta', records[0]);
  });

  it('stops forwarding deltas during cleanup', () => {
    registerNotificationHandlers({
      notificationService: service as never,
      windowManager: windowManager as never,
    });

    mocks.cleanup?.();
    emit?.(records[0]);

    expect(windowManager.sendToRenderer).not.toHaveBeenCalled();
    expect(mocks.removeHandler).toHaveBeenCalledWith('notification:list');
  });
});

function invoke(channel: string): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler();
}
