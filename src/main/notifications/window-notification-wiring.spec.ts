import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserActionRequest } from '../orchestration/orchestration-handler.types';

const mocks = vi.hoisted(() => ({
  service: { setOpenTargetHandler: vi.fn(), notify: vi.fn() },
  bus: { addTransport: vi.fn(), emitRendererEvent: vi.fn() },
}));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../notifications/notification-service', () => ({ getNotificationService: () => mocks.service }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => true }) }));
vi.mock('../event-bus/main-event-bus', () => ({ getMainEventBus: () => mocks.bus }));
vi.mock('../event-bus/electron-window-transport', () => ({ ElectronWindowTransport: class {} }));
import { WindowManager } from '../window-manager';

describe('WindowManager notification wiring', () => {
  beforeEach(() => vi.clearAllMocks());
  it('restores and focuses before sending the session target', () => {
    const manager = new WindowManager();
    const order: string[] = [];
    const window = { isDestroyed: () => false, isMinimized: () => true,
      restore: () => order.push('restore'), show: () => order.push('show'), focus: () => order.push('focus') };
    (manager as unknown as { mainWindow: unknown }).mainWindow = window;
    mocks.bus.emitRendererEvent.mockImplementation(() => order.push('send'));
    mocks.service.setOpenTargetHandler.mock.calls[0][0]('session-1');
    expect(order).toEqual(['restore', 'show', 'focus', 'send']);
    expect(mocks.bus.emitRendererEvent).toHaveBeenCalledWith('notification:open-target', { instanceId: 'session-1' });
  });
  it('names user action requests, clips the body and separates cooldowns by session', () => {
    const manager = new WindowManager(); vi.spyOn(manager, 'drawAttention').mockImplementation(() => {});
    const request = { id: 'r', instanceId: 'session-1', requestType: 'ask_questions', message: 'x'.repeat(200) } as UserActionRequest;
    manager.notifyUserActionRequest(request, 'Fix login');
    expect(mocks.service.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fix login needs your answer', body: 'x'.repeat(140), instanceId: 'session-1',
      fingerprintFields: { requestId: 'r' }, cooldownKey: 'user-action-request:session-1',
    }));
    expect(mocks.service.notify.mock.calls[0][0].onClick).toBeUndefined();
  });
});
