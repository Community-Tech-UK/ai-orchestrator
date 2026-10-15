import { BrowserWindow, powerMonitor } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { getSettingsManager } from '../core/config/settings-manager';
import { sendValidatedRendererEvent } from '../event-bus/renderer-event-validation';
import type { InstanceManager } from '../instance/instance-manager';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getPlanQueueStoreIfInitialized } from '../plan-queue/plan-queue-bootstrap';
import { getKeepAwakeService } from './keep-awake-service';
import { sessionKeepAwakeReasons } from './keep-awake-probes';

export function initializeKeepAwakeRuntime(instanceManager: InstanceManager): void {
  const settings = getSettingsManager();
  getKeepAwakeService().initialize({
    getMode: () => settings.get('keepAwakeMode'),
    probes: [
      () => sessionKeepAwakeReasons(instanceManager.getAllInstances(), Date.now()),
      () => getLoopCoordinator().getActiveLoops().some(loop => loop.status === 'running') ? ['loop'] : [],
      () => getPlanQueueStoreIfInitialized()?.hasActiveWork() ? ['plan-queue'] : [],
    ],
    broadcast: state => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed?.()) {
          sendValidatedRendererEvent(window.webContents, IPC_CHANNELS.APP_KEEP_AWAKE_STATE, state);
        }
      }
    },
    subscribe: reconcile => {
      settings.on('setting:keepAwakeMode', reconcile);
      powerMonitor.on('resume', reconcile);
      return () => {
        settings.removeListener('setting:keepAwakeMode', reconcile);
        powerMonitor.removeListener('resume', reconcile);
      };
    },
  });
}
