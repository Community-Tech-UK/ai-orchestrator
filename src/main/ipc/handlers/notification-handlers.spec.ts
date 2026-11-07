import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = () => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  removeHandler: vi.fn(),
  cleanup: null as (() => void) | null,
  setCount: vi.fn(),
  setWindowProvider: vi.fn(),
}));
vi.mock('../../app/attention-badge', () => ({ getAttentionBadge: () => ({ setCount: mocks.setCount, setWindowProvider: mocks.setWindowProvider }) }));

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
    markSeen: vi.fn(),
    dismiss: vi.fn(() => true),
    clear: vi.fn(() => 3),
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

  it('dismisses a validated record id and clears the whole center', async () => {
    registerNotificationHandlers({
      notificationService: service as never,
      windowManager: windowManager as never,
    });

    await expect(invoke('notification:dismiss', { id: 'notification-1' }))
      .resolves.toEqual({ success: true, data: { dismissed: true } });
    expect(service.dismiss).toHaveBeenCalledWith('notification-1');

    await expect(invoke('notification:clear'))
      .resolves.toEqual({ success: true, data: { cleared: 3 } });
    expect(service.clear).toHaveBeenCalledOnce();
  });

  it('rejects a dismiss payload that omits a valid id', async () => {
    registerNotificationHandlers({
      notificationService: service as never,
      windowManager: windowManager as never,
    });

    const response = await invoke('notification:dismiss', { id: '' }) as { success: boolean };
    expect(response.success).toBe(false);
    expect(service.dismiss).not.toHaveBeenCalled();
  });

  it('marks only a validated selection seen', async () => {
    registerNotificationHandlers({ notificationService: service as never, windowManager: windowManager as never });
    for (const selection of [{}, { ids: [] }, { ids: Array.from({ length: 101 }, () => 'n') }, { instanceId: '' }]) {
      expect(await invoke('notification:mark-seen', selection)).toMatchObject({ success: false });
    }
    expect(service.markSeen).not.toHaveBeenCalled();
    expect(await invoke('notification:mark-seen', { instanceId: 'a' })).toEqual({ success: true });
    expect(service.markSeen).toHaveBeenCalledWith({ instanceId: 'a' });
  });

  it('rejects invalid badge counts and sends a validated count to the badge service', async () => {
    registerNotificationHandlers({ notificationService: service as never, windowManager: windowManager as never });
    for (const count of [-1, 0.5, 10000, '3']) {
      expect(await invoke('notification:set-badge', { count })).toMatchObject({ success: false });
    }
    expect(mocks.setCount).not.toHaveBeenCalled();
    expect(await invoke('notification:set-badge', { count: 3 })).toEqual({ success: true });
    expect(mocks.setCount).toHaveBeenCalledWith(3);
  });

  it('stops forwarding deltas and removes every handler during cleanup', () => {
    registerNotificationHandlers({
      notificationService: service as never,
      windowManager: windowManager as never,
    });

    mocks.cleanup?.();
    emit?.(records[0]);

    expect(windowManager.sendToRenderer).not.toHaveBeenCalled();
    expect(mocks.removeHandler).toHaveBeenCalledWith('notification:list');
    expect(mocks.removeHandler).toHaveBeenCalledWith('notification:dismiss');
    expect(mocks.removeHandler).toHaveBeenCalledWith('notification:clear');
    expect(mocks.removeHandler).toHaveBeenCalledWith('notification:mark-seen');
    expect(mocks.removeHandler).toHaveBeenCalledWith('notification:set-badge');
  });
});

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return (handler as (event: unknown, payload: unknown) => Promise<unknown>)(undefined, payload);
}
