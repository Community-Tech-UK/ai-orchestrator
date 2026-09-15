import type { BrowserTarget } from '@contracts/types/browser';
import {
  BROWSER_EXTENSION_CONTACT_FRESH_MS,
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

/**
 * Channel state from the two contact clocks, which must never be merged for
 * delivery decisions:
 * - `coordinatorPollAt`: a poll RPC actually reached this coordinator
 *   (BrowserExtensionContactState). Commands are delivered only this way.
 * - `relayContactAt`: the worker relay saw the extension on its pipe
 *   (`capabilities.extensionRelay.lastExtensionContactAt`). The relay stamps
 *   this BEFORE forwarding, so it stays fresh while forwarding fails — the
 *   2026-09-15 stale-socket loop showed "last contacted 15s ago" for an hour
 *   while every command was not_delivered.
 */
export type RemoteExtensionChannelState = 'fresh' | 'relay_not_forwarding' | 'silent';

export interface RemoteExtensionContactClocks {
  state: RemoteExtensionChannelState;
  /** Most recent of both clocks; kept for existing `lastContactAt` fields. */
  lastContactAt?: number;
  coordinatorPollAt?: number;
  coordinatorPollAgeMs?: number;
  relayContactAt?: number;
  relayContactAgeMs?: number;
}

export function classifyRemoteExtensionContact(input: {
  coordinatorPollAt?: number;
  relayContactAt?: number;
  /** Node registration time; bounds the "no poll recorded yet" grace. */
  nodeConnectedAt?: number;
  now: number;
  freshMs?: number;
}): RemoteExtensionContactClocks {
  const freshMs = input.freshMs ?? BROWSER_EXTENSION_CONTACT_FRESH_MS;
  const { coordinatorPollAt, relayContactAt, nodeConnectedAt, now } = input;
  let state: RemoteExtensionChannelState;
  if (isBrowserExtensionContactFresh(coordinatorPollAt, now, freshMs)) {
    state = 'fresh';
  } else if (!isBrowserExtensionContactFresh(relayContactAt, now, freshMs)) {
    state = 'silent';
  } else if (coordinatorPollAt !== undefined) {
    state = 'relay_not_forwarding';
  } else {
    // No poll seen by this coordinator yet (fresh start or re-registration):
    // allow one freshness window from registration before blaming the worker.
    state = nodeConnectedAt !== undefined && now - nodeConnectedAt > freshMs
      ? 'relay_not_forwarding'
      : 'fresh';
  }
  const lastContactAt = latestTimestamp(coordinatorPollAt, relayContactAt);
  return {
    state,
    ...(lastContactAt !== undefined ? { lastContactAt } : {}),
    ...(coordinatorPollAt !== undefined
      ? { coordinatorPollAt, coordinatorPollAgeMs: Math.max(0, now - coordinatorPollAt) }
      : {}),
    ...(relayContactAt !== undefined
      ? { relayContactAt, relayContactAgeMs: Math.max(0, now - relayContactAt) }
      : {}),
  };
}

export function readRemoteExtensionContactClocks(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): RemoteExtensionContactClocks {
  const node = (deps.workerNodeRegistry ?? getWorkerNodeRegistry()).getNode(nodeId);
  return classifyRemoteExtensionContact({
    coordinatorPollAt: deps.extensionContactState.getLastExtensionContactAt(nodeId),
    relayContactAt: node?.capabilities.extensionRelay?.lastExtensionContactAt,
    nodeConnectedAt: node?.connectedAt,
    now: now(deps),
  });
}

/** Delivery freshness: true only when polls are (or may soon be) reaching the coordinator. */
export function isRemoteExtensionContactFresh(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): boolean {
  if (deps.extensionContactState.isExtensionContactFresh(nodeId)) {
    return true;
  }
  return readRemoteExtensionContactClocks(nodeId, deps).state === 'fresh';
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
 * `extension last contacted 42s ago` / `no extension contact recorded`, or —
 * when the worker relay sees polls the coordinator never receives —
 * `extension polled the relay 15s ago; the coordinator has not received a poll for 67m`.
 */
export function remoteExtensionContactSummary(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): string {
  const clocks = readRemoteExtensionContactClocks(nodeId, deps);
  const { lastContactAt } = clocks;
  const disconnect = deps.extensionContactState.getLastDisconnect?.(nodeId);
  const disconnectSuffix = disconnect && (lastContactAt === undefined || disconnect.at >= lastContactAt)
    ? `; channel disconnected ${Math.max(0, Math.round((now(deps) - disconnect.at) / 1000))}s ago (${disconnect.reason})`
    : '';
  if (clocks.state === 'relay_not_forwarding') {
    const coordinator = clocks.coordinatorPollAgeMs !== undefined
      ? `has not received a poll for ${formatAge(clocks.coordinatorPollAgeMs)}`
      : 'has not received a poll since the node registered';
    return `extension polled the relay ${formatAge(clocks.relayContactAgeMs ?? 0)} ago; the coordinator ${coordinator}`
      + ' (worker is not forwarding polls; browser.recover_extension resets the node connection)'
      + disconnectSuffix;
  }
  if (lastContactAt === undefined) {
    return `no extension contact recorded${disconnectSuffix}`;
  }
  const ageSeconds = Math.max(0, Math.round((now(deps) - lastContactAt) / 1000));
  return `extension last contacted ${ageSeconds}s ago${disconnectSuffix}`;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function remoteExtensionContactDescription(
  nodeId: string,
  deps: RemoteExtensionContactDeps,
): string {
  const clocks = readRemoteExtensionContactClocks(nodeId, deps);
  if (clocks.state === 'relay_not_forwarding') {
    return remoteExtensionContactSummary(nodeId, deps);
  }
  return clocks.lastContactAt === undefined
    ? 'no extension contact recorded'
    : `lastExtensionContactAt=${clocks.lastContactAt}`;
}

function now(deps: RemoteExtensionContactDeps): number {
  return deps.now?.() ?? Date.now();
}

function latestTimestamp(...values: Array<number | undefined>): number | undefined {
  const timestamps = values.filter((value): value is number => typeof value === 'number');
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}
