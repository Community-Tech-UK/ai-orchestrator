import { describe, expect, it, vi } from 'vitest';
import {
  NotificationService,
  stableNotificationFingerprint,
  type DesktopNotificationPort,
} from './notification-service';

function createHarness(options: {
  now?: () => number;
  quietHours?: { enabled: boolean; startHour: number; endHour: number };
} = {}) {
  const desktop: DesktopNotificationPort = {
    isSupported: vi.fn(() => true),
    show: vi.fn(),
  };
  const service = new NotificationService({
    desktop,
    now: options.now,
    quietHours: options.quietHours,
  });
  return { desktop, service };
}

describe('stableNotificationFingerprint', () => {
  it('is stable when fingerprint fields use a different property order', () => {
    expect(stableNotificationFingerprint('agent-finished', 'instance-1', { b: 2, a: 1 }))
      .toBe(stableNotificationFingerprint('agent-finished', 'instance-1', { a: 1, b: 2 }));
  });
});

describe('NotificationService', () => {
  it('keeps an in-app record when an identical notification is fingerprint-suppressed', () => {
    const { desktop, service } = createHarness();

    service.notify({ kind: 'agent-finished', instanceId: 'instance-1', title: 'Finished', body: 'One' });
    const duplicate = service.notify({ kind: 'agent-finished', instanceId: 'instance-1', title: 'Finished', body: 'One' });

    expect(desktop.show).toHaveBeenCalledTimes(1);
    expect(duplicate.delivery).toBe('fingerprint-suppressed');
    expect(service.list()).toHaveLength(2);
  });

  it('publishes the final delivery outcome to notification-center subscribers', () => {
    const { service } = createHarness();
    const received: string[] = [];
    service.subscribe((record) => received.push(record.delivery));

    service.notify({ kind: 'agent-finished', title: 'Finished', body: 'One' });
    service.notify({ kind: 'agent-finished', title: 'Finished', body: 'One' });

    expect(received).toEqual(['desktop', 'fingerprint-suppressed']);
  });

  it('flushes a cooldown burst as one digest while retaining individual in-app records', async () => {
    vi.useFakeTimers();
    try {
      const { desktop, service } = createHarness();

      service.notify({ kind: 'agent-finished', instanceId: 'one', title: 'Finished', body: 'One' });
      service.notify({ kind: 'agent-finished', instanceId: 'two', title: 'Finished', body: 'Two' });
      service.notify({ kind: 'agent-finished', instanceId: 'three', title: 'Finished', body: 'Three' });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(desktop.show).toHaveBeenCalledTimes(2);
      expect(desktop.show).toHaveBeenLastCalledWith(expect.objectContaining({
        title: 'Agent finished',
        body: '2 agents finished',
      }));
      expect(service.list()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps quiet-hours notifications in the center without showing a desktop notification', () => {
    const { desktop, service } = createHarness({
      now: () => new Date(2026, 6, 14, 23, 0, 0).getTime(),
      quietHours: { enabled: true, startHour: 22, endHour: 7 },
    });

    const record = service.notify({ kind: 'agent-finished', title: 'Finished', body: 'One' });

    expect(record.delivery).toBe('quiet-hours');
    expect(desktop.show).not.toHaveBeenCalled();
    expect(service.list()).toEqual([record]);
  });

  it('lets critical notifications bypass quiet hours and cooldown while still fingerprint-deduping', () => {
    const { desktop, service } = createHarness({
      now: () => new Date(2026, 6, 14, 23, 0, 0).getTime(),
      quietHours: { enabled: true, startHour: 22, endHour: 7 },
    });

    service.notify({ kind: 'automation-breaker', title: 'Breaker open', body: 'One', urgency: 'critical' });
    const duplicate = service.notify({ kind: 'automation-breaker', title: 'Breaker open', body: 'One', urgency: 'critical' });

    expect(desktop.show).toHaveBeenCalledTimes(1);
    expect(duplicate.delivery).toBe('fingerprint-suppressed');
  });

  it('reads cooldown policy at delivery time so settings apply without a restart', () => {
    let cooldownMs = 30_000;
    const desktop: DesktopNotificationPort = { isSupported: vi.fn(() => true), show: vi.fn() };
    const service = new NotificationService({
      desktop,
      policyReader: () => ({ cooldownMs }),
    });

    service.notify({ kind: 'agent-finished', instanceId: 'one', title: 'Finished', body: 'One' });
    cooldownMs = 0;
    service.notify({ kind: 'agent-finished', instanceId: 'two', title: 'Finished', body: 'Two' });

    expect(desktop.show).toHaveBeenCalledTimes(2);
  });

  it('rechecks quiet hours before a queued digest is delivered', async () => {
    vi.useFakeTimers();
    // Pin the clock to a deterministic hour inside the quiet window enabled below.
    // Without this the service reads the real wall-clock time (via Date.now), so
    // the digest recheck would spuriously deliver when the suite runs during an
    // hour the window excludes (e.g. hour 23 for a 0..23 window).
    vi.setSystemTime(new Date(2026, 6, 14, 3, 0, 0));
    try {
      let quietHours = { enabled: false, startHour: 22, endHour: 7 };
      const desktop: DesktopNotificationPort = { isSupported: vi.fn(() => true), show: vi.fn() };
      const service = new NotificationService({
        desktop,
        policyReader: () => ({ quietHours }),
      });

      service.notify({ kind: 'agent-finished', instanceId: 'one', title: 'Finished', body: 'One' });
      service.notify({ kind: 'agent-finished', instanceId: 'two', title: 'Finished', body: 'Two' });
      quietHours = { enabled: true, startHour: 0, endHour: 23 };
      await vi.advanceTimersByTimeAsync(30_000);

      expect(desktop.show).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a record when the desktop notification API throws', () => {
    const desktop: DesktopNotificationPort = {
      isSupported: vi.fn(() => true),
      show: vi.fn(() => { throw new Error('desktop unavailable'); }),
    };
    const service = new NotificationService({ desktop });

    const record = service.notify({ kind: 'agent-finished', title: 'Finished', body: 'One' });

    expect(record.delivery).toBe('desktop-unavailable');
    expect(service.list()).toEqual([record]);
  });

  it('isolates a failed notification-center listener from other subscribers', () => {
    const { service } = createHarness();
    const received = vi.fn();
    service.subscribe(() => { throw new Error('renderer disconnected'); });
    service.subscribe(received);

    const record = service.notify({ kind: 'agent-finished', title: 'Finished', body: 'One' });

    expect(received).toHaveBeenCalledWith(record);
  });

  it('bounds retained fingerprint state for long-running app sessions', () => {
    const { service } = createHarness();
    for (let index = 0; index < 2_001; index++) {
      service.notify({ kind: `event-${index}`, title: 'Event', body: String(index) });
    }

    const internal = service as unknown as { fingerprintLastSeen: Map<string, number> };
    expect(internal.fingerprintLastSeen.size).toBeLessThanOrEqual(2_000);
  });
});
