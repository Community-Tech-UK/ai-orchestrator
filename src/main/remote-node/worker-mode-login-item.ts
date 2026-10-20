import { app } from 'electron';
import type { WorkerModeSettings } from '../../shared/types/pair-both.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('WorkerModeLoginItem');

interface WorkerModeSettingsSource {
  get(key: 'workerMode'): WorkerModeSettings;
  on(event: 'setting:workerMode', listener: (value: WorkerModeSettings) => void): unknown;
}

export interface BindWorkerModeLoginItemOptions {
  settings?: WorkerModeSettingsSource;
  applyLoginItem?: (openAtLogin: boolean) => void;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
}

export function wantsOpenAtLogin(workerMode: WorkerModeSettings): boolean {
  return workerMode.role === 'worker' && workerMode.openAtLogin === true;
}

/**
 * Keep the OS login item in step with "Open Harness when I sign in". This is
 * the no-admin way for a worker computer to come back after a reboot: Harness
 * opens as the signed-in user (so the worker keeps that user's CLI logins and
 * desktop) and the launch autostart starts the worker.
 *
 * Only packaged Windows/macOS builds are touched: Electron has no login items
 * on Linux, and registering a dev build would launch the bare Electron binary.
 * At startup the item is only ever turned ON, so a user who later disables it
 * from the OS (Windows "Startup apps") is not overridden on every launch; it
 * is turned off when the user turns the option or worker mode off.
 */
export function bindWorkerModeLoginItem(options: BindWorkerModeLoginItemOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const isPackaged = options.isPackaged ?? app.isPackaged;
  if ((platform !== 'win32' && platform !== 'darwin') || !isPackaged) {
    return;
  }
  const settings: WorkerModeSettingsSource = options.settings ?? getSettingsManager();
  const applyLoginItem = options.applyLoginItem
    ?? ((openAtLogin: boolean) => app.setLoginItemSettings({ openAtLogin }));

  const apply = (openAtLogin: boolean): void => {
    try {
      applyLoginItem(openAtLogin);
      logger.info('Updated open-at-login for worker mode', { openAtLogin });
    } catch (error) {
      logger.warn('Could not update open-at-login for worker mode', {
        openAtLogin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let applied = wantsOpenAtLogin(settings.get('workerMode'));
  if (applied) {
    apply(true);
  }
  settings.on('setting:workerMode', (value) => {
    const next = wantsOpenAtLogin(value);
    if (next !== applied) {
      applied = next;
      apply(next);
    }
  });
}
