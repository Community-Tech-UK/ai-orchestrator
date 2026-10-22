import { promises as fs } from 'fs';
import { getLogger } from '../logging/logger';
import { getNotificationService } from '../notifications/notification-service';
import type { NotificationInput } from '../notifications/notification-service';

const logger = getLogger('LowDiskSpaceWatcher');

const GB = 1024 * 1024 * 1024;
export const LOW_DISK_WARNING_BYTES = 50 * GB;
export const LOW_DISK_CRITICAL_BYTES = 10 * GB;
const LOW_DISK_POLL_MS = 10 * 60 * 1000;
/** Repeat while space stays low: quiet hours or cooldown may have hidden the first notice. */
const LOW_DISK_REMINDER_MS = 24 * 60 * 60 * 1000;

export type DiskSpaceLevel = 'ok' | 'low' | 'critical';

export function diskSpaceLevel(freeBytes: number): DiskSpaceLevel {
  if (freeBytes < LOW_DISK_CRITICAL_BYTES) return 'critical';
  if (freeBytes < LOW_DISK_WARNING_BYTES) return 'low';
  return 'ok';
}

export interface LowDiskSpaceWatcherDeps {
  getFreeBytes: () => Promise<number>;
  notify: (input: NotificationInput) => void;
  now?: () => number;
}

/**
 * Warns when the drive holding Harness data runs low. In October 2026 the
 * user's 4 TB drive reached 3.6 GB free with no warning from Harness, while
 * agents kept writing repo copies and the code index kept growing.
 *
 * Notifies when the level gets worse (ok → low → critical) and once a day
 * while it stays low, not on every poll, and resets once space recovers.
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
    if (!worsened && !reminderDue) return level;
    this.lastNotifiedAt = now;

    const freeGb = Math.max(0, Math.floor(freeBytes / GB));
    logger.warn('Disk space is running low', { freeBytes, level });
    this.deps.notify({
      kind: 'low-disk-space',
      title: level === 'critical' ? 'Your disk is almost full' : 'Your disk is getting full',
      body: level === 'critical'
        ? `Only ${freeGb} GB is free. Agents, builds and Harness itself will start failing soon. Free up space now.`
        : `${freeGb} GB is free. Free up some space before agents and builds start failing.`,
      urgency: level === 'critical' ? 'critical' : 'normal',
      fingerprintFields: { level },
    });
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
      notify: (input) => { getNotificationService().notify(input); },
    });
    instance.start();
  }
  return instance;
}

export function _resetForTesting(): void {
  instance?.stop();
  instance = null;
}
