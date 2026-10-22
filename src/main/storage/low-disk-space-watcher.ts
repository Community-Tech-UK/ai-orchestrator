import { promises as fs } from 'fs';
import { getLogger } from '../logging/logger';
import { getNotificationService } from '../notifications/notification-service';
import type { NotificationInput } from '../notifications/notification-service';
import type { NotificationDelivery } from '../../shared/types/notification.types';

const logger = getLogger('LowDiskSpaceWatcher');

const GB = 1024 * 1024 * 1024;
export const LOW_DISK_WARNING_BYTES = 50 * GB;
export const LOW_DISK_CRITICAL_BYTES = 10 * GB;
const LOW_DISK_POLL_MS = 10 * 60 * 1000;
/** Repeat while space stays low: quiet hours or cooldown may have hidden the first notice. */
const LOW_DISK_REMINDER_MS = 24 * 60 * 60 * 1000;
/** Retry a held-back notice hourly; every attempt adds an entry to the in-app list. */
const LOW_DISK_RETRY_MS = 60 * 60 * 1000;

export type DiskSpaceLevel = 'ok' | 'low' | 'critical';

export function diskSpaceLevel(freeBytes: number): DiskSpaceLevel {
  if (freeBytes < LOW_DISK_CRITICAL_BYTES) return 'critical';
  if (freeBytes < LOW_DISK_WARNING_BYTES) return 'low';
  return 'ok';
}

export interface LowDiskSpaceWatcherDeps {
  getFreeBytes: () => Promise<number>;
  /** Returns false when the notice was held back (quiet hours, cooldown, duplicate). */
  notify: (input: NotificationInput) => boolean;
  now?: () => number;
}

/** Whether a notification actually reached the user rather than being held back. */
export function wasNotificationShown(delivery: NotificationDelivery): boolean {
  return delivery === 'desktop' || delivery === 'desktop-unavailable';
}

/**
 * Warns when the drive holding Harness data runs low. In October 2026 the
 * user's 4 TB drive reached 3.6 GB free with no warning from Harness, while
 * agents kept writing repo copies and the code index kept growing.
 *
 * Notifies when the level gets worse (ok → low → critical) and once a day
 * while it stays low, not on every poll, and resets once space recovers. A
 * notice held back by quiet hours or cooldown is retried an hour later.
 */
export class LowDiskSpaceWatcher {
  private lastLevel: DiskSpaceLevel = 'ok';
  private lastNotifiedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: LowDiskSpaceWatcherDeps) {}

  start(pollMs = LOW_DISK_POLL_MS): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<DiskSpaceLevel> {
    let freeBytes: number;
    try {
      freeBytes = await this.deps.getFreeBytes();
    } catch (error) {
      logger.warn('Could not read free disk space', { error: error instanceof Error ? error.message : String(error) });
      return this.lastLevel;
    }

    const level = diskSpaceLevel(freeBytes);
    const now = (this.deps.now ?? Date.now)();
    const worsened = severity(level) > severity(this.lastLevel);
    const reminderDue = level !== 'ok' && now - this.lastNotifiedAt >= LOW_DISK_REMINDER_MS;
    this.lastLevel = level;
    if (level === 'ok') this.lastNotifiedAt = 0;
    if (!worsened && !reminderDue) return level;

    const freeGb = Math.max(0, Math.floor(freeBytes / GB));
    logger.warn('Disk space is running low', { freeBytes, level });
    const shown = this.deps.notify({
      kind: 'low-disk-space',
      title: level === 'critical' ? 'Your disk is almost full' : 'Your disk is getting full',
      body: level === 'critical'
        ? `Only ${freeGb} GB is free. Agents, builds and Harness itself will start failing soon. Free up space now.`
        : `${freeGb} GB is free. Free up some space before agents and builds start failing.`,
      urgency: level === 'critical' ? 'critical' : 'normal',
      fingerprintFields: { level },
    });
    // Held back: try again in an hour rather than waiting a day.
    this.lastNotifiedAt = shown ? now : now - LOW_DISK_REMINDER_MS + LOW_DISK_RETRY_MS;
    return level;
  }
}

function severity(level: DiskSpaceLevel): number {
  return level === 'critical' ? 2 : level === 'low' ? 1 : 0;
}

let instance: LowDiskSpaceWatcher | null = null;

/** Start watching the volume that holds `dataPath`. Idempotent. */
export function startLowDiskSpaceWatcher(dataPath: string): LowDiskSpaceWatcher {
  if (!instance) {
    instance = new LowDiskSpaceWatcher({
      getFreeBytes: async () => {
        const disk = await fs.statfs(dataPath);
        return disk.bavail * disk.bsize;
      },
      notify: (input) => wasNotificationShown(getNotificationService().notify(input).delivery),
    });
    instance.start();
  }
  return instance;
}

export function _resetForTesting(): void {
  instance?.stop();
  instance = null;
}
