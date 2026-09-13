import type { BrowserExtensionRecoverResult } from '../main/remote-node/node-control-rpc-schemas';
import type { WorkerExtensionRelayConfig } from './worker-config';
import type { WorkerExtensionRelay } from './worker-extension-relay';

interface WorkerExtensionRelayRecoveryOptions {
  config: WorkerExtensionRelayConfig | undefined;
  relay: Pick<WorkerExtensionRelay, 'getSummary' | 'restart'>;
  forceRegistrationCheck: () => void;
  sendHeartbeat: () => Promise<void>;
}

export async function recoverWorkerExtensionRelay(
  options: WorkerExtensionRelayRecoveryOptions,
): Promise<BrowserExtensionRecoverResult> {
  if (!options.config?.enabled) {
    throw new Error('Browser extension relay is not configured and enabled on this worker');
  }
  const before = options.relay.getSummary();
  if (!before) {
    throw new Error('Browser extension relay summary is unavailable');
  }

  await options.relay.restart();
  options.forceRegistrationCheck();
  const after = options.relay.getSummary();
  if (!after) {
    throw new Error('Browser extension relay summary is unavailable after recovery');
  }
  await options.sendHeartbeat();
  return { before, after };
}
