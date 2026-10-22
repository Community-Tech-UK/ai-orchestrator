import { describe, expect, it, vi } from 'vitest';
import {
  wasNotificationShown,
  LOW_DISK_CRITICAL_BYTES,
  LOW_DISK_WARNING_BYTES,
  LowDiskSpaceWatcher,
  diskSpaceLevel,
} from './low-disk-space-watcher';

vi.mock('../notifications/notification-service', () => ({
  getNotificationService: () => ({ notify: vi.fn() }),
}));

const GB = 1024 * 1024 * 1024;

function watcherWith(freeBytes: number[], clock = { now: Date.UTC(2026, 9, 22) }) {
  const readings = [...freeBytes];
  const notify = vi.fn((): boolean => true);
  const watcher = new LowDiskSpaceWatcher({
    getFreeBytes: async () => readings.shift() ?? 0,
    notify,
    now: () => clock.now,
  });
  return { watcher, notify };
}

describe('diskSpaceLevel', () => {
  it('maps free space to a level', () => {
    expect(diskSpaceLevel(LOW_DISK_WARNING_BYTES)).toBe('ok');
    expect(diskSpaceLevel(LOW_DISK_WARNING_BYTES - 1)).toBe('low');
    expect(diskSpaceLevel(LOW_DISK_CRITICAL_BYTES - 1)).toBe('critical');
  });
});

describe('wasNotificationShown', () => {
  it('treats held-back deliveries as not shown', () => {
    expect(wasNotificationShown('desktop')).toBe(true);
    expect(wasNotificationShown('desktop-unavailable')).toBe(true);
    expect(wasNotificationShown('quiet-hours')).toBe(false);
    expect(wasNotificationShown('cooldown-suppressed')).toBe(false);
    expect(wasNotificationShown('fingerprint-suppressed')).toBe(false);
  });
});

describe('LowDiskSpaceWatcher', () => {
  it('stays quiet while there is plenty of space', async () => {
    const { watcher, notify } = watcherWith([500 * GB, 400 * GB]);

    await watcher.check();
    await watcher.check();

    expect(notify).not.toHaveBeenCalled();
  });

  it('warns once when space runs low and again when it becomes critical', async () => {
    const { watcher, notify } = watcherWith([42 * GB, 40 * GB, 3.6 * GB, 3 * GB]);

    expect(await watcher.check()).toBe('low');
    expect(await watcher.check()).toBe('low');
    expect(await watcher.check()).toBe('critical');
    expect(await watcher.check()).toBe('critical');

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      kind: 'low-disk-space',
      title: 'Your disk is getting full',
      body: expect.stringContaining('42 GB is free'),
      urgency: 'normal',
    });
    expect(notify.mock.calls[1]![0]).toMatchObject({
      title: 'Your disk is almost full',
      body: expect.stringContaining('Only 3 GB is free'),
      urgency: 'critical',
    });
  });

  it('warns again after space recovered and then ran low again', async () => {
    const { watcher, notify } = watcherWith([30 * GB, 700 * GB, 30 * GB]);

    await watcher.check();
    await watcher.check();
    await watcher.check();

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('reminds once a day while space stays low', async () => {
    const clock = { now: Date.UTC(2026, 9, 22) };
    const { watcher, notify } = watcherWith([30 * GB, 30 * GB, 30 * GB], clock);

    await watcher.check();
    clock.now += 23 * 60 * 60 * 1000;
    await watcher.check();
    clock.now += 60 * 60 * 1000;
    await watcher.check();

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('retries an hour later when quiet hours held the notice back', async () => {
    const clock = { now: Date.UTC(2026, 9, 22) };
    const { watcher, notify } = watcherWith([30 * GB, 30 * GB, 30 * GB], clock);
    notify.mockReturnValueOnce(false);

    await watcher.check();
    clock.now += 30 * 60 * 1000;
    await watcher.check();
    clock.now += 30 * 60 * 1000;
    await watcher.check();

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous level when free space cannot be read', async () => {
    const notify = vi.fn((): boolean => true);
    const watcher = new LowDiskSpaceWatcher({
      getFreeBytes: async () => { throw new Error('statfs failed'); },
      notify,
    });

    expect(await watcher.check()).toBe('ok');
    expect(notify).not.toHaveBeenCalled();
  });
});
