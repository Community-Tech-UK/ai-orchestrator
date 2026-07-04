import {
  browserExtensionQueueKeyForNode,
  type BrowserExtensionCommandStore,
} from './browser-extension-command-store';
import type { BrowserGatewayListTargetsRequest } from './browser-gateway-service-types';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';

const EXTENSION_INVENTORY_REFRESH_TIMEOUT_MS = 3_000;
const EXTENSION_INVENTORY_REFRESH_EXECUTION_MS = 2_500;

export async function refreshBrowserExtensionInventory(input: {
  request: BrowserGatewayListTargetsRequest;
  commandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
}): Promise<void> {
  const queueKeys = extensionInventoryRefreshQueueKeys(input.request);
  await Promise.all(queueKeys.map((queueKey) =>
    input.commandStore.sendCommand({
      queueKey,
      command: 'report_inventory',
      timeoutMs: EXTENSION_INVENTORY_REFRESH_TIMEOUT_MS,
      executionTimeoutMs: EXTENSION_INVENTORY_REFRESH_EXECUTION_MS,
    }).catch(() => undefined),
  ));
}

function extensionInventoryRefreshQueueKeys(
  request: BrowserGatewayListTargetsRequest,
): string[] {
  if (request.nodeId) {
    return [browserExtensionQueueKeyForNode(request.nodeId)];
  }
  const queueKeys = new Set<string>(['local']);
  for (const node of getWorkerNodeRegistry().getAllNodes()) {
    if (
      node.capabilities.extensionRelay?.enabled === true
      || node.capabilities.hasExtensionRelay === true
    ) {
      queueKeys.add(browserExtensionQueueKeyForNode(node.id));
    }
  }
  return [...queueKeys];
}
