import { app } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getAutoUpdateService } from './auto-update-service';
import { SourceUpdateService } from './source-update-service';
import { SourceUpdateDriverClient } from './source-update-driver-client';
import { createSourceUpdateMaintenance } from './source-update-maintenance';
import { readBuildInfo } from '../app/build-info';
import { isHarnessLiveTest } from '../app/live-test-context';
import { getSettingsManager } from '../core/config/settings-manager';
import type { InstanceManager } from '../instance/instance-manager';

let sourceService: SourceUpdateService | null = null;

export function usesSourceUpdates(context: {
  platform: NodeJS.Platform; packaged: boolean; liveTest: boolean;
  executable: string; home: string; hasConfig: boolean;
}): boolean {
  return context.platform === 'darwin' && context.packaged && !context.liveTest && context.hasConfig
    && path.resolve(context.executable) === path.join(context.home, 'Applications', 'Harness.app', 'Contents', 'MacOS', 'Harness');
}

/** Source mode is machine-local; an invalid opt-in fails visibly instead of installing a competing release. */
export function getDesktopUpdateService(manager: InstanceManager) {
  if (process.platform !== 'darwin' || !app.isPackaged || isHarnessLiveTest()) return getAutoUpdateService();
  const home = homedir();
  const config = path.join(home, '.orchestrator', 'home-base', 'source-updates.json');
  if (!usesSourceUpdates({
    platform: process.platform, packaged: app.isPackaged, liveTest: isHarnessLiveTest(),
    executable: app.getPath('exe'), home, hasConfig: existsSync(config),
  })) return getAutoUpdateService();
  if (!sourceService || !sourceService.getStatus().enabled) {
    const maintenance = createSourceUpdateMaintenance(manager);
    const info = readBuildInfo(app.getVersion(), app.getPath('userData'));
    sourceService = new SourceUpdateService({
      currentVersion: app.getVersion(), currentCommit: info.commit ?? '', pid: process.pid,
      driver: new SourceUpdateDriverClient(config),
      maintenance: {
        ...maintenance,
        isIdle: () => getSettingsManager().get('workerMode').role === 'coordinator' && maintenance.isIdle(),
        tryAcquire: () => getSettingsManager().get('workerMode').role === 'coordinator'
          ? maintenance.tryAcquire() : Promise.resolve(null),
      },
      quit: () => app.quit(),
    });
  }
  return sourceService;
}

/** Called after all boot steps and the main window's ready callback, never merely app.whenReady. */
export async function markDesktopUpdatesReady(): Promise<void> {
  await sourceService?.markReady();
}

export function resetSourceUpdatesForTesting(): void {
  sourceService?.dispose();
  sourceService = null;
}
