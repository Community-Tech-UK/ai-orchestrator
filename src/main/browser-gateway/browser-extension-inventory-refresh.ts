import {
  browserExtensionQueueKeyForNode,
  type BrowserExtensionCommandStore,
} from './browser-extension-command-store';
import type { BrowserGatewayListTargetsRequest } from './browser-gateway-service-types';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';

const EXTENSION_INVENTORY_REFRESH_TIMEOUT_MS = 3_000;
const EXTENSION_INVENTORY_REFRESH_EXECUTION_MS = 2_500;

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
