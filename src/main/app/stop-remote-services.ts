import { getThinClientWsServer } from '../event-bus/thin-client-ws-server';
import {
  getWorkerNodeConnectionServer,
  getWorkerNodeHealth,
} from '../remote-node';
import { getWorkerModeRuntimeService } from '../remote-node/worker-mode-runtime-service';

/**
 * Shutdown phase that stops every remote-facing service. Each step is best
 * effort: one failing service must never stop the others from being stopped.
 */
export async function stopRemoteServices(): Promise<void> {
  try { getWorkerNodeHealth().stopAll(); } catch { /* best effort */ }
  try { getWorkerNodeConnectionServer().stop(); } catch { /* best effort */ }
  // "Run while Harness is open" worker: stop it with the app rather than
  // leaving an orphan that the next launch cannot see or stop.
  try { getWorkerModeRuntimeService().stop(); } catch { /* best effort */ }
  try { await getThinClientWsServer().stop(); } catch { /* best effort */ }
}
