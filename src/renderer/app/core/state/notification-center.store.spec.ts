import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { SessionNavigator } from '../services/session-navigator.service';
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
  const openSession = vi.fn();
  let targetCallback: ((target: { instanceId: string }) => void) | null;
  let deltaCallback: ((record: NotificationRecord) => void) | null;
  const api = {
    notificationList: vi.fn(),
    notificationMarkSeen: vi.fn(async () => ({ success: true })),
    onNotificationOpenTarget: vi.fn((callback: (target: { instanceId: string }) => void) => {
      targetCallback = callback; return () => { targetCallback = null; };
    }),
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
    targetCallback = null;
    vi.clearAllMocks();
    api.notificationList.mockResolvedValue({ success: true, data: [FIRST] });
    api.notificationDismiss.mockResolvedValue({ success: true, data: { dismissed: true } });
    api.notificationClear.mockResolvedValue({ success: true, data: { cleared: 0 } });
    TestBed.configureTestingModule({
      providers: [
        NotificationCenterStore,
        { provide: SessionNavigator, useValue: { openSession } },
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

  it('counts only unseen unresolved records and marks a selected session seen', async () => {
    api.notificationList.mockResolvedValue({ success: true, data: [
      { ...FIRST, instanceId: 'a' }, { ...LATEST, resolvedAt: 4 },
      { ...FIRST, id: 'seen', seenAt: 5 },
    ] });
    const store = TestBed.inject(NotificationCenterStore); store.init(); await store.load();
    expect(store.count()).toBe(1);
    await store.markSeen({ instanceId: 'a' });
    expect(api.notificationMarkSeen).toHaveBeenCalledWith({ instanceId: 'a' });
    expect(store.count()).toBe(0);
    expect(store.records()).toHaveLength(3);
  });

  it('opens push targets and removes its listener on dispose', () => {
    const store = TestBed.inject(NotificationCenterStore); store.init();
    targetCallback?.({ instanceId: 'a' });
    expect(openSession).toHaveBeenCalledWith('a');
    store.dispose(); expect(targetCallback).toBeNull();
  });

  it('keeps a newer seen delta when an older snapshot arrives', async () => {
    const store = TestBed.inject(NotificationCenterStore); store.init();
    deltaCallback?.({ ...FIRST, seenAt: 10, updatedAt: 10 });
    await store.load(); expect(store.count()).toBe(0);
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
