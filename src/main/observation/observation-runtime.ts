import { app } from 'electron';
import { getSettingsManager } from '../core/config/settings-manager';
import type { InstanceManager } from '../instance/instance-manager';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getContextWorkerClient } from '../instance/context-worker-client';
import { getObservationIngestor } from './observation-ingestor';
import { getObserverAgent } from './observer-agent';
import { getReflectorAgent } from './reflector-agent';
import { getPolicyAdapter } from './policy-adapter';
import { getObservationStore } from './observation-store';

const DAILY_MS = 24 * 60 * 60 * 1000;
let stop: (() => void) | undefined;

/** Retention is independent of capture consent: expired rows are always removed. */
export function initializeObservationRuntime(instanceManager: InstanceManager): void {
  stop?.();
  const settings = getSettingsManager();
  const apply = (): void => {
    const enabled = settings.get('observationMemoryEnabled') === true;
    getObservationIngestor().configure({ enabled });
    getObserverAgent().configure({ enabled });
    getReflectorAgent().configure({ enabled });
    getPolicyAdapter().configure({ enabled });
    getContextWorkerClient().setObservationMemoryEnabled(enabled);
    getObservationStore().configure({ enabled });
  };
  apply();
  getObservationIngestor().initialize(instanceManager, id =>
    getLoopCoordinator().getActiveLoops().some(loop => loop.chatId === id && loop.endedAt === null));
  getObservationStore().applyDecay(); // Logs removed observation/reflection counts.
  const timer = setInterval(() => getObservationStore().applyDecay(), DAILY_MS);
  timer.unref();
  settings.on('setting:observationMemoryEnabled', apply);
  const cleanup = (): void => {
    clearInterval(timer);
    settings.removeListener('setting:observationMemoryEnabled', apply);
    app.removeListener('before-quit', cleanup);
    if (stop === cleanup) stop = undefined;
  };
  stop = cleanup;
  app.once('before-quit', cleanup);
}
