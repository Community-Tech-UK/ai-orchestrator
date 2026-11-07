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
  it('folds an identical notification into the unresolved record', () => {
    const { desktop, service } = createHarness();

    service.notify({ kind: 'agent-finished', instanceId: 'instance-1', title: 'Finished', body: 'One' });
    const duplicate = service.notify({ kind: 'agent-finished', instanceId: 'instance-1', title: 'Finished', body: 'One' });

    expect(desktop.show).toHaveBeenCalledTimes(1);
    expect(duplicate.repeatCount).toBe(2);
    expect(service.list()).toHaveLength(1);
  });

  it('publishes the final delivery outcome to notification-center subscribers', () => {
    const { service } = createHarness();
    const received: string[] = [];
    service.subscribe((record) => received.push(record.delivery));

    service.notify({ kind: 'agent-finished', title: 'Finished', body: 'One' });
    service.notify({ kind: 'agent-finished', title: 'Finished', body: 'One' });

    expect(received).toEqual(['desktop', 'desktop']);
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

  it('does not title another kind\'s digest "Agent finished"', async () => {
    vi.useFakeTimers();
    try {
      const { desktop, service } = createHarness();

      service.notify({ kind: 'quota-pacing', title: 'Quota', body: 'One', fingerprintFields: { n: 1 } });
      service.notify({ kind: 'quota-pacing', title: 'Quota', body: 'Two', fingerprintFields: { n: 2 } });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(desktop.show).toHaveBeenLastCalledWith(expect.objectContaining({
        title: 'More Harness notifications',
        body: '1 quota pacing notifications',
      }));
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
    expect(duplicate.repeatCount).toBe(2);
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

  it('dismisses a single retained record by id and reports whether it existed', () => {
    const { service } = createHarness();
    const first = service.notify({ kind: 'agent-finished', instanceId: 'one', title: 'Finished', body: 'One' });
    const second = service.notify({ kind: 'agent-finished', instanceId: 'two', title: 'Finished', body: 'Two' });

    expect(service.dismiss(first.id)).toBe(true);
    expect(service.list()).toEqual([second]);
    expect(service.dismiss('missing')).toBe(false);
    expect(service.list()).toEqual([second]);
  });

  it('clears every retained record and reports how many were removed', () => {
    const { service } = createHarness();
    service.notify({ kind: 'agent-finished', instanceId: 'one', title: 'Finished', body: 'One' });
    service.notify({ kind: 'agent-finished', instanceId: 'two', title: 'Finished', body: 'Two' });

    expect(service.clear()).toBe(2);
    expect(service.list()).toEqual([]);
    expect(service.clear()).toBe(0);
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

 describe('notification lifecycle', () => {
  it('folds hourly reminders without suppressing desktop delivery after the dedupe window', () => {
    let now = 0;
    const { service, desktop } = createHarness({ now: () => now });
    const input = { kind: 'pending-approvals', title: 'Approval', body: 'Waiting', resolveKey: 'pending-approvals' };
    const first = service.notify(input); now = 60 * 60_000;
    const reminder = service.notify(input);
    expect(desktop.show).toHaveBeenCalledTimes(2);
    expect(reminder.id).toBe(first.id); expect(reminder.repeatCount).toBe(2);
    expect(service.list()).toHaveLength(1);
    service.dispose();
  });

  it('raises the unseen state again when a seen problem recurs, and keeps it unseen until it is seen again', () => {
    let now = 10;
    const { service } = createHarness({ now: () => now });
    const input = { kind: 'input', instanceId: 'a', title: 'Approval', body: 'Waiting', resolveKey: 'input:1' };
    const first = service.notify(input);
    now = 20; service.markSeen({ ids: [first.id] });
    expect(service.list()[0].seenAt).toBe(20);

    now = 30;
    const repeat = service.notify(input);
    expect(repeat.id).toBe(first.id); expect(repeat.repeatCount).toBe(2);
    expect(repeat.seenAt).toBeUndefined();
    expect(service.list()).toHaveLength(1); expect(service.list()[0].seenAt).toBeUndefined();

    now = 40; service.markSeen({ ids: [first.id] });
    expect(service.list()[0].seenAt).toBe(40);
    service.dispose();
  });

  it('marks seen by ids or session and resolves only matching unresolved keys', () => {
    let now = 10;
    const { service } = createHarness({ now: () => now });
    const a = service.notify({ kind: 'input', instanceId: 'a', title: 'Approval', body: '', resolveKey: 'input:1' });
    const b = service.notify({ kind: 'input', instanceId: 'b', title: 'Approval', body: '', resolveKey: 'input:2' });
    now = 20;
    service.markSeen({ ids: [a.id] });
    expect(service.list().find(r => r.id === a.id)?.seenAt).toBe(20);
    expect(service.list().find(r => r.id === b.id)?.seenAt).toBeUndefined();
    service.markSeen({ instanceId: 'b' });
    service.resolve('input:1');
    expect(service.list().find(r => r.id === a.id)?.resolvedAt).toBe(20);
    expect(service.list().find(r => r.id === b.id)?.resolvedAt).toBeUndefined();
    const next = service.notify({ kind: 'input', instanceId: 'a', title: 'Approval', body: '', resolveKey: 'input:1' });
    expect(next.id).not.toBe(a.id);
    service.dispose();
  });

  it('uses a session click by default and respects explicit click handlers', () => {
    const { service, desktop } = createHarness();
    const open = vi.fn();
    const explicit = vi.fn();
    service.setOpenTargetHandler(open);
    service.notify({ kind: 'input', instanceId: 'a', title: 'Approval', body: '', cooldownKey: 'input:a' });
    service.notify({ kind: 'input', instanceId: 'b', title: 'Approval', body: '', cooldownKey: 'input:b', onClick: explicit });
    expect(desktop.show).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(desktop.show).mock.calls;
    calls[0][0].onClick?.();
    calls[1][0].onClick?.();
    expect(open).toHaveBeenCalledWith('a');
    expect(explicit).toHaveBeenCalledOnce();
    service.dispose();
  });
});

describe('deduplication across resolved episodes', () => {
  it.each(['normal', 'critical'] as const)('deduplicates a reopened %s episode', urgency => {
    let now = 0;
    const { service, desktop } = createHarness({ now: () => now });
    const notice = { kind: 'node-disconnected', title: 'Worker disconnected', body: 'Worker needs attention',
      resolveKey: 'node:example', fingerprintFields: { nodeId: 'example' }, urgency };
    service.notify(notice); service.resolve(notice.resolveKey);
    now = urgency === 'normal' ? 31_000 : 1;
    const reopened = service.notify(notice);
    now += urgency === 'normal' ? 31_000 : 1;
    const repeat = service.notify(notice);
    expect(desktop.show).toHaveBeenCalledTimes(2);
    expect(repeat.id).toBe(reopened.id);
    expect(repeat.repeatCount).toBe(2);
    expect(service.list()).toHaveLength(2);
    service.dispose();
  });
  it('does not reset duplicate suppression when a notice is only seen', () => {
    const { service, desktop } = createHarness();
    const notice = { kind: 'node-disconnected', title: 'Worker disconnected', body: '', urgency: 'critical' as const };
    const first = service.notify(notice);
    service.markSeen({ ids: [first.id] }); service.notify(notice);
    expect(desktop.show).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it.each(['dismiss', 'clear'] as const)('retains suppression after %s', operation => {
    const { service, desktop } = createHarness();
    const notice = { kind: 'node-disconnected', title: 'Worker disconnected', body: '', urgency: 'critical' as const };
    const first = service.notify(notice);
    if (operation === 'dismiss') service.dismiss(first.id); else service.clear();
    expect(service.notify(notice).delivery).toBe('fingerprint-suppressed');
    expect(desktop.show).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});
