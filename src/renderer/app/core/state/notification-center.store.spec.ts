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
});
