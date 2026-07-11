/**
 * Main-process lifecycle wrapper around electron-updater.
 *
 * Packaged applications check after a short startup delay, poll without
 * overlap, let electron-updater download in the background, and install an
 * already-downloaded update on normal quit.
 */

import { EventEmitter } from 'node:events';
import type {
  UpdateErrorContext,
  UpdateStatus,
} from '../../shared/types/update.types';
import { getLogger } from '../logging/logger';

export type {
  UpdateState,
  UpdateStatus,
} from '../../shared/types/update.types';

const logger = getLogger('AutoUpdate');
const DEFAULT_STARTUP_DELAY_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 4 * 60 * 60 * 1_000;

function isUpdateActive(state: UpdateStatus['state']): boolean {
  return state === 'available' || state === 'downloading' || state === 'downloaded';
}

/** Minimal surface of electron-updater's autoUpdater that Harness depends on. */
export interface UpdaterLike extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AutoUpdateServiceDeps {
  /** electron-updater autoUpdater (lazily required by default). */
  autoUpdater?: UpdaterLike;
  currentVersion?: string;
  /** Clock injection keeps status timestamps deterministic in tests. */
  now?: () => Date;
}

export interface AutoUpdateInitOptions {
  enabled: boolean;
  autoDownload?: boolean;
  currentVersion?: string;
  startupDelayMs?: number;
  pollIntervalMs?: number;
}

interface UpdaterListener {
  event: string;
  listener: (...args: unknown[]) => void;
}

export class AutoUpdateService extends EventEmitter {
  private updater: UpdaterLike | null;
  private status: UpdateStatus;
  private readonly now: () => Date;
  private wired = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private checkInFlight: Promise<UpdateStatus> | null = null;
  private downloadInFlight: Promise<UpdateStatus> | null = null;
  private updaterListeners: UpdaterListener[] = [];

  constructor(deps: AutoUpdateServiceDeps = {}) {
    super();
    this.updater = deps.autoUpdater ?? null;
    this.now = deps.now ?? (() => new Date());
    this.status = { state: 'idle', enabled: false, currentVersion: deps.currentVersion };
  }

  private getUpdater(): UpdaterLike | null {
    if (this.updater) return this.updater;
    try {
      // Deferred require keeps electron-updater out of browser/dev-only paths.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('electron-updater') as { autoUpdater: UpdaterLike };
      this.updater = mod.autoUpdater;
      return this.updater;
    } catch (error) {
      logger.warn('electron-updater is not available', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  initialize(options: AutoUpdateInitOptions): void {
    this.status = {
      ...this.status,
      enabled: options.enabled,
      currentVersion: options.currentVersion ?? this.status.currentVersion,
    };
    if (!options.enabled) {
      logger.info('Auto-update disabled (not packaged or explicitly off)');
      this.setStatus({ state: 'idle' });
      return;
    }

    const updater = this.getUpdater();
    if (!updater) {
      this.setStatus({ state: 'error', error: 'Updater unavailable', errorContext: 'check' });
      return;
    }

    updater.autoDownload = options.autoDownload ?? true;
    updater.autoInstallOnAppQuit = true;
    if (!this.wired) {
      this.wireEvents(updater);
      this.wired = true;
    }
    this.scheduleChecks(
      options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    logger.info('Auto-update initialized', { autoDownload: updater.autoDownload });
  }

  private wireEvents(updater: UpdaterLike): void {
    this.addUpdaterListener(updater, 'checking-for-update', () => {
      this.setStatus({ state: 'checking', error: undefined, errorContext: undefined });
    });
    this.addUpdaterListener(updater, 'update-available', (value) => {
      const info = value as { version?: string } | undefined;
      this.setStatus({
        state: 'available',
        availableVersion: info?.version,
        error: undefined,
        errorContext: undefined,
      });
    });
    this.addUpdaterListener(updater, 'update-not-available', () => {
      this.setStatus({ state: 'not-available', error: undefined, errorContext: undefined });
    });
    this.addUpdaterListener(updater, 'download-progress', (value) => {
      const progress = value as { percent?: number } | undefined;
      this.setStatus({
        state: 'downloading',
        percent: Math.round(progress?.percent ?? 0),
        error: undefined,
        errorContext: undefined,
      });
    });
    this.addUpdaterListener(updater, 'update-downloaded', (value) => {
      const info = value as { version?: string } | undefined;
      this.setStatus({
        state: 'downloaded',
        availableVersion: info?.version,
        percent: 100,
        error: undefined,
        errorContext: undefined,
      });
    });
    this.addUpdaterListener(updater, 'error', (value) => {
      const errorContext: UpdateErrorContext = this.status.state === 'available'
        || this.status.state === 'downloading'
        ? 'download'
        : 'check';
      this.setStatus({
        state: 'error',
        error: value instanceof Error ? value.message : String(value),
        errorContext,
      });
    });
  }

  private addUpdaterListener(
    updater: UpdaterLike,
    event: string,
    listener: (...args: unknown[]) => void,
  ): void {
    updater.on(event, listener);
    this.updaterListeners.push({ event, listener });
  }

  private scheduleChecks(startupDelayMs: number, pollIntervalMs: number): void {
    this.clearTimers();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates();
      this.pollTimer = setInterval(() => {
        void this.checkForUpdates();
      }, pollIntervalMs);
      this.pollTimer.unref?.();
    }, startupDelayMs);
    this.startupTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.startupTimer = null;
    this.pollTimer = null;
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.status.enabled) return this.getStatus();
    if (this.checkInFlight) return this.checkInFlight;
    if (isUpdateActive(this.status.state)) return this.getStatus();
    const updater = this.getUpdater();
    if (!updater) {
      this.setStatus({ state: 'error', error: 'Updater unavailable', errorContext: 'check' });
      return this.getStatus();
    }

    this.checkInFlight = (async () => {
      try {
        this.setStatus({
          state: 'checking',
          lastCheckedAt: this.now().toISOString(),
          error: undefined,
          errorContext: undefined,
        });
        await updater.checkForUpdates();
      } catch (error) {
        this.setStatus({
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          errorContext: 'check',
        });
      } finally {
        this.checkInFlight = null;
      }
      return this.getStatus();
    })();
    return this.checkInFlight;
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (!this.status.enabled) return this.getStatus();
    if (this.downloadInFlight) return this.downloadInFlight;
    const updater = this.getUpdater();
    if (!updater) return this.getStatus();

    this.downloadInFlight = (async () => {
      try {
        this.setStatus({
          state: 'downloading',
          percent: 0,
          error: undefined,
          errorContext: undefined,
        });
        await updater.downloadUpdate();
      } catch (error) {
        this.setStatus({
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          errorContext: 'download',
        });
      } finally {
        this.downloadInFlight = null;
      }
      return this.getStatus();
    })();
    return this.downloadInFlight;
  }

  quitAndInstall(): boolean {
    if (this.status.state !== 'downloaded') return false;
    const updater = this.getUpdater();
    if (!updater) return false;
    try {
      updater.quitAndInstall();
      return true;
    } catch (error) {
      this.setStatus({
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
        errorContext: 'install',
      });
      return false;
    }
  }

  dispose(): void {
    this.clearTimers();
    if (this.updater) {
      for (const { event, listener } of this.updaterListeners) {
        this.updater.off(event, listener);
      }
    }
    this.updaterListeners = [];
    this.wired = false;
    this.checkInFlight = null;
    this.downloadInFlight = null;
    this.status = {
      state: 'idle',
      enabled: false,
      currentVersion: this.status.currentVersion,
    };
    this.removeAllListeners();
  }
}

let singleton: AutoUpdateService | null = null;

export function getAutoUpdateService(): AutoUpdateService {
  singleton ??= new AutoUpdateService();
  return singleton;
}

export function _resetForTesting(): void {
  singleton?.dispose();
  singleton = null;
}
