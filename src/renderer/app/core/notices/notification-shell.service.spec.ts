import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { IpcFacadeService } from '../services/ipc';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { ToastService } from '../services/toast.service';
import { InstanceStore } from '../state/instance.store';
import { NotificationCenterStore } from '../state/notification-center.store';
import { ToolLoopAlertStore } from '../state/tool-loop-alert.store';
import { SessionNavigator } from '../services/session-navigator.service';
import { NotificationShellService } from './notification-shell.service';

describe('NotificationShellService', () => {
  const selected = signal<string | null>(null);
  const liveIds = signal(new Set<string>());
  const center = { init: vi.fn(), markSessionSeen: vi.fn() };
  const openSession = vi.fn();
  let listener: (event: unknown) => void;
  beforeEach(() => {
    vi.clearAllMocks(); selected.set(null); liveIds.set(new Set());
    TestBed.configureTestingModule({ providers: [
      { provide: IpcFacadeService, useValue: { on: (_channel: string, callback: typeof listener) => { listener = callback; return vi.fn(); } } },
      { provide: InstanceStore, useValue: { selectedInstanceId: selected } },
      { provide: ToolLoopAlertStore, useValue: { liveIds } },
      { provide: NotificationCenterStore, useValue: center },
      { provide: SessionNavigator, useValue: { openSession } },
    ] });
  });
  it('keeps critical tool-loop errors until their live cause clears and opens the session', () => {
    const shell = TestBed.inject(NotificationShellService); const toast = TestBed.inject(ToastService);
    shell.start(); liveIds.set(new Set(['a']));
    listener({ instanceId: 'a', severity: 'critical', toolName: 'Read', windowDescription: 'Repeated' });
    TestBed.tick();
    expect(toast.toasts()[0].type).toBe('error'); toast.toasts()[0].action?.run();
    expect(openSession).toHaveBeenCalledWith('a');
    liveIds.set(new Set()); TestBed.tick(); expect(toast.toasts()).toEqual([]);
  });
  it('marks the selected session seen and gives warnings the warning timeout', () => {
    vi.useFakeTimers();
    try {
      TestBed.inject(NotificationShellService).start(); selected.set('a'); TestBed.tick();
      expect(center.markSessionSeen).toHaveBeenCalledWith('a');
      listener({ instanceId: 'a', severity: 'warn', toolName: 'Read', windowDescription: 'Repeated' });
      const toast = TestBed.inject(ToastService); expect(toast.toasts()[0].type).toBe('warning');
      vi.advanceTimersByTime(8000); expect(toast.toasts()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('NotificationShellService with the real NotificationCenterStore', () => {
  const selected = signal<string | null>(null);
  const liveIds = signal(new Set<string>());
  const openSession = vi.fn();
  const notificationMarkSeen = vi.fn().mockResolvedValue({ success: true });
  let deliver: (record: NotificationRecord) => void;
  const record = (patch: Partial<NotificationRecord>): NotificationRecord => ({
    id: 'n', kind: 'loop', title: 'T', body: 'B', urgency: 'normal', fingerprint: 'f',
    createdAt: Date.now(), delivery: 'desktop', instanceId: 'inst-a', ...patch,
  });
  beforeEach(() => {
    vi.clearAllMocks(); selected.set(null); liveIds.set(new Set()); deliver = () => undefined;
    TestBed.configureTestingModule({ providers: [
      { provide: IpcFacadeService, useValue: { on: () => vi.fn() } },
      { provide: ElectronIpcService, useValue: { getApi: () => ({
        notificationList: vi.fn().mockResolvedValue({ success: true, data: [] }),
        onNotificationDelta: (callback: (value: NotificationRecord) => void) => { deliver = callback; return () => undefined; },
        notificationMarkSeen,
      }) } },
      { provide: InstanceStore, useValue: { selectedInstanceId: selected } },
      { provide: ToolLoopAlertStore, useValue: { liveIds } },
      { provide: SessionNavigator, useValue: { openSession } },
    ] });
  });

  it('marks a session seen only when the user selects it, not on every new notification', async () => {
    TestBed.inject(NotificationShellService).start();
    const center = TestBed.inject(NotificationCenterStore);
    deliver(record({ id: 'n1' })); TestBed.tick();
    expect(center.count()).toBe(1);
    expect(notificationMarkSeen).not.toHaveBeenCalled();

    selected.set('inst-a'); TestBed.tick();
    await vi.waitFor(() => expect(notificationMarkSeen).toHaveBeenCalledWith({ instanceId: 'inst-a' }));
    await vi.waitFor(() => expect(center.count()).toBe(0));

    notificationMarkSeen.mockClear();
    deliver(record({ id: 'n2' })); TestBed.tick();
    expect(center.count()).toBe(1);
    expect(notificationMarkSeen).not.toHaveBeenCalled();

    deliver(record({ id: 'n3', instanceId: 'inst-b' })); selected.set('inst-b'); TestBed.tick();
    await vi.waitFor(() => expect(notificationMarkSeen).toHaveBeenCalledWith({ instanceId: 'inst-b' }));
  });
});
