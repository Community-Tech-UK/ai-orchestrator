/**
 * N6 — periodic check that the process is still running the build on disk.
 *
 * Only meaningful unpackaged: a packaged app has no `dist/main` that can change
 * underneath it, so the watcher declines to start rather than polling something
 * that will always report `unknown`.
 */

import { app } from 'electron';

import { getLogger } from '../logging/logger';
import { getNotificationService } from '../notifications/notification-service';
import {
  detectBuildSkew,
  describeBuildSkew,
  readBuildFingerprint,
  type BuildFingerprint,
} from './build-skew';

const logger = getLogger('BuildSkewWatcher');

/** Slow on purpose: a rebuild is a human-scale event, not a hot path. */
export const BUILD_SKEW_POLL_MS = 60_000;

export interface BuildSkewWatcherOptions {
  appRoot?: string;
  pollMs?: number;
  isPackaged?: boolean;
  /** Test seam. */
  onSkew?: (message: string) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let bootFingerprint: BuildFingerprint | null = null;
let alreadyReported = false;

/**
 * Start watching. Idempotent — a second call while running is a no-op rather
 * than a second interval.
 */
export function startBuildSkewWatcher(options: BuildSkewWatcherOptions = {}): void {
  if (timer) return;
  const packaged = options.isPackaged ?? app?.isPackaged ?? false;
  if (packaged) return;

  const appRoot = options.appRoot ?? process.cwd();
  bootFingerprint = readBuildFingerprint(appRoot);
  if (!bootFingerprint) {
    // Nothing to compare against later, so polling would only ever say
    // "unknown". Say why once instead of every minute.
    logger.debug('Build skew watch not started: no compiled entry point to fingerprint');
    return;
  }
  alreadyReported = false;

  timer = setInterval(() => {
    const skew = detectBuildSkew(bootFingerprint, readBuildFingerprint(appRoot));
    const message = describeBuildSkew(skew);
    if (!message || alreadyReported) return;
    // Report once per process: the build does not become more stale, and a
    // nag every minute would train the operator to ignore it.
    alreadyReported = true;
    logger.warn('Running build differs from the build on disk', { appRoot });
    if (options.onSkew) {
      options.onSkew(message);
      return;
    }
    getNotificationService().notify({
      kind: 'build-skew',
      title: 'Restart to pick up your rebuild',
      body: message,
      urgency: 'normal',
    });
  }, options.pollMs ?? BUILD_SKEW_POLL_MS);
  timer.unref?.();
}

export function stopBuildSkewWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
  bootFingerprint = null;
  alreadyReported = false;
}

export function _resetForTesting(): void {
  stopBuildSkewWatcher();
}
