import type { BrowserTarget } from '@contracts/types/browser';
import {
  BROWSER_EXTENSION_CONTACT_FRESH_MS,
  describeBrowserExtensionContact,
  isBrowserExtensionContactFresh,
  type BrowserExtensionContactStateReader,
} from './browser-extension-contact-state';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { AgentSafeTarget } from './browser-safe-dto';
import type { BrowserGatewayFindOrOpenRequest } from './browser-gateway-service-types';
import {
  getWorkerNodeRegistry,
  type WorkerNodeRegistry,
} from '../remote-node/worker-node-registry';

export interface RemoteExtensionContactDeps {
  extensionContactState: BrowserExtensionContactStateReader;
  workerNodeRegistry?: Pick<WorkerNodeRegistry, 'getNode'>;
  now?: () => number;
}

export function isRemoteExtensionContactFresh(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): boolean {
  if (deps.extensionContactState.isExtensionContactFresh(nodeId)) {
    return true;
  }
  return isBrowserExtensionContactFresh(
    remoteExtensionRelayLastContactAt(nodeId, deps),
    now(deps),
    BROWSER_EXTENSION_CONTACT_FRESH_MS,
  );
}

export function withRemoteExtensionStaleFlag(
  target: BrowserTarget,
  deps: RemoteExtensionContactDeps,
): BrowserTarget {
  if (target.nodeId && target.driver === 'extension' && !isRemoteExtensionContactFresh(target.nodeId, deps)) {
    return {
      ...target,
      stale: true,
      lastConfirmedAt: target.lastConfirmedAt ?? target.lastSeenAt,
    };
  }
  return target;
}

export function remoteExtensionUnreachableFindOrOpenInput(params: {
  request: BrowserGatewayFindOrOpenRequest;
  profileId?: string;
  targetId?: string;
  actionClass: 'read' | 'navigate';
  url?: string;
  origin?: string;
  nodeId: string;
  deps: RemoteExtensionContactDeps;
}): BrowserGatewayResultInput<AgentSafeTarget | null> {
  return {
    context: params.request,
    profileId: params.profileId,
    targetId: params.targetId,
    action: 'find_or_open',
    toolName: 'browser.find_or_open',
    actionClass: params.actionClass,
    decision: 'allowed',
    outcome: 'failed',
    reason: 'browser_extension_unreachable',
    summary: `Remote Browser Gateway extension node ${params.nodeId} is unreachable (${remoteExtensionContactDescription(
      params.nodeId,
      params.deps,
    )})`,
    origin: params.origin,
    url: params.url,
    data: null,
  };
}

/**
 * Human-readable channel state for error messages, e.g.
 * `extension last contacted 42s ago` / `no extension contact recorded`.
 * Merges host-observed contact with the worker relay's own summary, since
 * either side may have seen the extension more recently.
 */
export function remoteExtensionContactSummary(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): string {
  const lastContactAt = latestTimestamp(
    deps.extensionContactState.getLastExtensionContactAt(nodeId),
    remoteExtensionRelayLastContactAt(nodeId, deps),
  );
  const disconnect = deps.extensionContactState.getLastDisconnect?.(nodeId);
  const disconnectSuffix = disconnect && (lastContactAt === undefined || disconnect.at >= lastContactAt)
    ? `; channel disconnected ${Math.max(0, Math.round((now(deps) - disconnect.at) / 1000))}s ago (${disconnect.reason})`
    : '';
  if (lastContactAt === undefined) {
    return `no extension contact recorded${disconnectSuffix}`;
  }
  const ageSeconds = Math.max(0, Math.round((now(deps) - lastContactAt) / 1000));
  return `extension last contacted ${ageSeconds}s ago${disconnectSuffix}`;
}

function remoteExtensionContactDescription(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): string {
  const lastContactAt = latestTimestamp(
    deps.extensionContactState.getLastExtensionContactAt(nodeId),
    remoteExtensionRelayLastContactAt(nodeId, deps),
  );
  const contact = describeBrowserExtensionContact(
    nodeId,
    lastContactAt,
    now(deps),
    BROWSER_EXTENSION_CONTACT_FRESH_MS,
  );
  return contact.lastContactAt === undefined
    ? 'no extension contact recorded'
    : `lastExtensionContactAt=${contact.lastContactAt}`;
}

function remoteExtensionRelayLastContactAt(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): number | undefined {
  return (deps.workerNodeRegistry ?? getWorkerNodeRegistry())
    .getNode(nodeId)
    ?.capabilities.extensionRelay
    ?.lastExtensionContactAt;
}

function now(deps: RemoteExtensionContactDeps): number {
  return deps.now?.() ?? Date.now();
}

function latestTimestamp(...values: Array<number | undefined>): number | undefined {
  const timestamps = values.filter((value): value is number => typeof value === 'number');
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}
