/**
 * Auto-update service (backlog #24).
 *
 * Thin wrapper around electron-updater's `autoUpdater` that:
 *   - normalizes its event stream into a single observable status object,
 *   - is disabled by default in dev (no `app.isPackaged`) so it never throws on
 *     a missing update feed,
 *   - takes the updater + app as injected deps so the status state-machine is
 *     unit-testable without Electron.
 *
 * Notarization is a separate, signing-cert-gated concern (electron-builder.json
 * still has notarize:false) — this only wires the in-app update flow.
 */

import { EventEmitter } from 'node:events';
import { getLogger } from '../logging/logger';

const logger = getLogger('AutoUpdate');

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  enabled: boolean;
  currentVersion?: string;
  availableVersion?: string;
  /** Download progress 0–100 while state === 'downloading'. */
  percent?: number;
  error?: string;
}

/** Minimal surface of electron-updater's autoUpdater that we depend on. */
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
  /** Current app version, for display. */
  currentVersion?: string;
}

export interface AutoUpdateInitOptions {
  /** Master switch. Defaults to app.isPackaged at the call site. */
  enabled: boolean;
  /** Download automatically when an update is found. Default false (user-driven). */
  autoDownload?: boolean;
}

export class AutoUpdateService extends EventEmitter {
  private updater: UpdaterLike | null;
  private status: UpdateStatus;
  private wired = false;

  constructor(deps: AutoUpdateServiceDeps = {}) {
    super();
    this.updater = deps.autoUpdater ?? null;
    this.status = { state: 'idle', enabled: false, currentVersion: deps.currentVersion };
  }

  /** Lazily resolve the real electron-updater autoUpdater (main process only). */
  private getUpdater(): UpdaterLike | null {
    if (this.updater) return this.updater;
    try {
      // Deferred require: electron-updater pulls in electron, so only load it
      // when actually initializing in the packaged app.
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
    this.status = { ...this.status, enabled: options.enabled };
    if (!options.enabled) {
      logger.info('Auto-update disabled (not packaged or explicitly off)');
      this.setStatus({ state: 'idle' });
      return;
    }

    const updater = this.getUpdater();
    if (!updater) {
      this.setStatus({ state: 'error', error: 'Updater unavailable' });
      return;
    }

    updater.autoDownload = options.autoDownload ?? false;
    if (!this.wired) {
      this.wireEvents(updater);
      this.wired = true;
    }
    logger.info('Auto-update initialized', { autoDownload: updater.autoDownload });
  }

  private wireEvents(updater: UpdaterLike): void {
    updater.on('checking-for-update', () => this.setStatus({ state: 'checking', error: undefined }));
    updater.on('update-available', (info: { version?: string }) =>
      this.setStatus({ state: 'available', availableVersion: info?.version }),
    );
    updater.on('update-not-available', () => this.setStatus({ state: 'not-available' }));
    updater.on('download-progress', (p: { percent?: number }) =>
      this.setStatus({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }),
    );
    updater.on('update-downloaded', (info: { version?: string }) =>
      this.setStatus({ state: 'downloaded', availableVersion: info?.version, percent: 100 }),
    );
    updater.on('error', (err: Error) =>
      this.setStatus({ state: 'error', error: err?.message ?? String(err) }),
    );
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
    const updater = this.getUpdater();
    if (!updater) {
      this.setStatus({ state: 'error', error: 'Updater unavailable' });
      return this.getStatus();
    }
    try {
      this.setStatus({ state: 'checking', error: undefined });
      await updater.checkForUpdates();
    } catch (error) {
      this.setStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    return this.getStatus();
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (!this.status.enabled) return this.getStatus();
    const updater = this.getUpdater();
    if (!updater) return this.getStatus();
    try {
      this.setStatus({ state: 'downloading', percent: 0 });
      await updater.downloadUpdate();
    } catch (error) {
      this.setStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    return this.getStatus();
  }

  /** Quit and install a downloaded update. No-op unless state === 'downloaded'. */
  quitAndInstall(): boolean {
    if (this.status.state !== 'downloaded') return false;
    const updater = this.getUpdater();
    if (!updater) return false;
    updater.quitAndInstall();
    return true;
  }
}

let singleton: AutoUpdateService | null = null;

export function getAutoUpdateService(): AutoUpdateService {
  singleton ??= new AutoUpdateService();
  return singleton;
}

export function _resetAutoUpdateServiceForTesting(): void {
  singleton = null;
}
