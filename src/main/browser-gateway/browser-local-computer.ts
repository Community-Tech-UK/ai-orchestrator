import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import { readWorkerModePairing } from '../remote-node/worker-mode-runtime-service';
import type { BrowserComputer } from './browser-computer-balancer';

/** Reserved chooser identity; it is never sent to a remote worker. */
export const LOCAL_BROWSER_COMPUTER_ID = 'local';

export function getLocalBrowserComputer(): BrowserComputer | undefined {
  if (!getRemoteNodeConfig().localBrowserComputerEnabled) return undefined;
  return {
    id: LOCAL_BROWSER_COMPUTER_ID,
    // The home base and the worker serving another Harness share this computer.
    // Reuse its existing name so a prompt names the same Chrome from either side.
    name: readWorkerModePairing(join(homedir(), '.orchestrator', 'worker-node.json')).config?.name
      || hostname().replace(/\.local$/i, ''),
    capabilities: { platform: process.platform, hasBrowserMcp: true },
  };
}
