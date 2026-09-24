import {
  BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
  browserExtensionQueueKeyForNode,
  type BrowserExtensionCommandStore,
} from './browser-extension-command-store';
import type { BrowserGatewayListTargetsRequest } from './browser-gateway-service-types';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';

// LT-618: report_inventory rebuilds the FULL per-tab inventory (page-text
// extraction plus secret-taint lineage checks) before it can ack at all — see
// browser-gateway-refresh-support.ts's own comment, which already documents
// that this "routinely outlives its [former] 2.5-3s execution window" on any
// real multi-tab node. That budget was tight enough that a normal local
// Chrome profile blew it on essentially every refresh: the extension's own
// watchdog (runCommandWithWatchdog in background.js) fired first and replied
// with a bare timeout while the real reportTabInventory() call kept running
// in the background, uncancelled, still holding the extension's shared
// secretObservationBoundary — which every subsequent non-reload command must
// also wait on (applySecretObservationProtectionFromCommand). That is a
// second, deeper defect (queueing every future command behind an orphaned
// inventory build with no bound), but this budget being far too tight for
// ordinary multi-tab machines is what triggers it on every single refresh
// instead of only in a genuine slow-page edge case. Raised to give a normal
// handful of real tabs room to finish while staying well under the 30s
// default full-command budget non-refresh report_inventory calls already get
// (browser-secret-observation-protection.ts uses 5s for a much smaller,
// single-purpose ping).
const EXTENSION_INVENTORY_REFRESH_TIMEOUT_MS = 10_500;
const EXTENSION_INVENTORY_REFRESH_EXECUTION_MS = 10_000;

export interface BrowserExtensionInventoryRefreshOutcome {
  queueKey: string;
  /** nodeId for node queues; undefined for the local extension queue. */
  nodeId?: string;
  ok: boolean;
  error?: string;
}

/**
 * Ask connected extensions to re-send tab inventory. Best-effort and bounded —
 * but NOT silent: each queue's outcome is returned so `list_targets` can tell
 * the caller "this node's targets are cached, the live refresh failed" instead
 * of presenting stale inventory as proof the channel is alive.
 */
export async function refreshBrowserExtensionInventory(input: {
  request: BrowserGatewayListTargetsRequest;
  commandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  localOnly?: boolean;
}): Promise<BrowserExtensionInventoryRefreshOutcome[]> {
  const targets = extensionInventoryRefreshTargets(input.request, input.localOnly === true);
  return Promise.all(targets.map(async ({ queueKey, nodeId }) => {
    try {
      await input.commandStore.sendCommand({
        queueKey,
        command: 'report_inventory',
        timeoutMs: EXTENSION_INVENTORY_REFRESH_TIMEOUT_MS,
        executionTimeoutMs: EXTENSION_INVENTORY_REFRESH_EXECUTION_MS,
        undeliveredWaitMs: BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
      });
      return { queueKey, ...(nodeId ? { nodeId } : {}), ok: true };
    } catch (error) {
      return {
        queueKey,
        ...(nodeId ? { nodeId } : {}),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

function extensionInventoryRefreshTargets(
  request: BrowserGatewayListTargetsRequest,
  localOnly: boolean,
): Array<{ queueKey: string; nodeId?: string }> {
  if (request.nodeId) {
    return [{ queueKey: browserExtensionQueueKeyForNode(request.nodeId), nodeId: request.nodeId }];
  }
  const targets = new Map<string, { queueKey: string; nodeId?: string }>();
  targets.set('local', { queueKey: 'local' });
  if (localOnly) {
    return [...targets.values()];
  }
  for (const node of getWorkerNodeRegistry().getAllNodes()) {
    if (
      node.capabilities.extensionRelay?.enabled === true
      || node.capabilities.hasExtensionRelay === true
    ) {
      const queueKey = browserExtensionQueueKeyForNode(node.id);
      targets.set(queueKey, { queueKey, nodeId: node.id });
    }
  }
  return [...targets.values()];
}
