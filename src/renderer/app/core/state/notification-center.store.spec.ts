import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { NotificationCenterStore } from './notification-center.store';

const FIRST: NotificationRecord = {
  id: 'notification-1',
  kind: 'agent-finished',
  title: 'Finished',
  body: 'One',
  urgency: 'normal',
  fingerprint: 'one',
  createdAt: 1,
  delivery: 'desktop',
};

const LATEST: NotificationRecord = {
  ...FIRST,
  id: 'notification-2',
  title: 'Needs input',
  createdAt: 2,
  delivery: 'quiet-hours',
};

describe('NotificationCenterStore', () => {
  let deltaCallback: ((record: NotificationRecord) => void) | null;
  const api = {
    notificationList: vi.fn(),
    notificationDismiss: vi.fn(),
    notificationClear: vi.fn(),
    onNotificationDelta: vi.fn((callback: (record: NotificationRecord) => void) => {
      deltaCallback = callback;
      return () => {
        deltaCallback = null;
      };
    }),
  };

  beforeEach(() => {
    deltaCallback = null;
    vi.clearAllMocks();
    api.notificationList.mockResolvedValue({ success: true, data: [FIRST] });
    api.notificationDismiss.mockResolvedValue({ success: true, data: { dismissed: true } });
    api.notificationClear.mockResolvedValue({ success: true, data: { cleared: 0 } });
    TestBed.configureTestingModule({
      providers: [
        NotificationCenterStore,
        { provide: ElectronIpcService, useValue: { getApi: () => api } },
      ],
    });
  });

  it('loads the initial center snapshot and prepends push deltas', async () => {
    const store = TestBed.inject(NotificationCenterStore);

    store.init();
    await store.load();
    deltaCallback?.(LATEST);

    expect(api.onNotificationDelta).toHaveBeenCalledOnce();
    expect(store.records()).toEqual([LATEST, FIRST]);
    expect(store.count()).toBe(2);
  });

  it('does not duplicate a record when a snapshot repeats a pushed delta', async () => {
    const store = TestBed.inject(NotificationCenterStore);
    api.notificationList.mockResolvedValue({ success: true, data: [LATEST, FIRST] });

    store.init();
    deltaCallback?.(LATEST);
    await store.load();

    expect(store.records()).toEqual([LATEST, FIRST]);
  });

  it('removes a dismissed record and forwards the id to the main process', async () => {
    api.notificationList.mockResolvedValue({ success: true, data: [] });
    const store = TestBed.inject(NotificationCenterStore);
    store.init();
    deltaCallback?.(FIRST);
    deltaCallback?.(LATEST);

    await store.dismiss(FIRST.id);

    expect(api.notificationDismiss).toHaveBeenCalledWith(FIRST.id);
    expect(store.records()).toEqual([LATEST]);
  });

  it('restores the prior records when a dismiss fails', async () => {
    api.notificationList.mockResolvedValue({ success: true, data: [] });
    api.notificationDismiss.mockResolvedValue({ success: false, error: { message: 'nope' } });
    const store = TestBed.inject(NotificationCenterStore);
    store.init();
    deltaCallback?.(FIRST);

    await store.dismiss(FIRST.id);

    expect(store.records()).toEqual([FIRST]);
    expect(store.error()).toBe('nope');
  });

  it('clears every record and asks the main process to clear', async () => {
    api.notificationList.mockResolvedValue({ success: true, data: [] });
    const store = TestBed.inject(NotificationCenterStore);
    store.init();
    deltaCallback?.(FIRST);
    deltaCallback?.(LATEST);

    await store.clearAll();

    expect(api.notificationClear).toHaveBeenCalledOnce();
    expect(store.records()).toEqual([]);
  });
});
