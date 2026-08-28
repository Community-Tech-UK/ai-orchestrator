import type { BrowserProfile, BrowserTarget } from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import {
  getWorkerNodeRegistry,
  matchNodeByCapabilityTag,
} from '../remote-node/worker-node-registry';
import { resolveBrowserComputerTarget } from './browser-computer-target';
import { getBrowserProfileStore } from './browser-profile-store';
import { getBrowserTargetRegistry } from './browser-target-registry';

interface BrowserRemoteOffloadConfig {
  enabled: boolean;
  autoOffloadBrowser: boolean;
}

export interface BrowserRemoteOffloadPolicyDeps {
  getConfig: () => BrowserRemoteOffloadConfig;
  getConnectedNodes: () => WorkerNodeInfo[];
  listTargets: () => BrowserTarget[];
  getProfile: (profileId: string) => BrowserProfile | null;
}

const DISCOVERY_METHODS = new Set([
  'browser.list_targets',
  'browser.preflight_target',
  'browser.find_or_open',
]);

const TARGET_SCOPED_METHODS = new Set([
  'browser.select_target',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.fill_form',
  'browser.select',
  'browser.execute_fill_plan',
  'browser.fill_credential',
  'browser.fill_secret',
  'browser.create_agent_credential',
  'browser.upload_file',
  'browser.download_file',
  'browser.request_user_login',
  'browser.pause_for_manual_step',
  'browser.request_grant',
  'browser.snapshot',
  'browser.accessibility_snapshot',
  'browser.evaluate',
  'browser.screenshot',
  'browser.console_messages',
  'browser.network_requests',
  'browser.wait_for',
  'browser.query_elements',
  'browser.assert_persisted',
  'browser.write_journal',
  'browser.check_session',
]);

const RELEVANT_METHODS = new Set([
  ...DISCOVERY_METHODS,
  ...TARGET_SCOPED_METHODS,
  'browser.open_profile',
]);

const defaultDeps: BrowserRemoteOffloadPolicyDeps = {
  getConfig: getRemoteNodeConfig,
  getConnectedNodes: () => getWorkerNodeRegistry().getHealthyNodes(),
  listTargets: () => getBrowserTargetRegistry().listTargets(),
  getProfile: (profileId) => getBrowserProfileStore().getProfile(profileId),
};

/**
 * Enforce the remote-browser preference at the authenticated Browser Gateway
 * boundary. Prompt guidance is insufficient here: long-lived agent sessions
 * can retain an older prompt and explicitly request `computer: "local"`.
 *
 * Discovery requests are transparently routed to a connected browser-capable
 * worker. Calls that already carry a coordinator-local target/profile are
 * rejected because a target id is machine-specific and cannot safely be
 * rewritten to a different computer.
 */
export function routeBrowserGatewayRequest(
  method: string,
  payload: Record<string, unknown>,
  deps: BrowserRemoteOffloadPolicyDeps = defaultDeps,
): Record<string, unknown> {
  if (!RELEVANT_METHODS.has(method)) {
    return payload;
  }

  const config = deps.getConfig();
  if (!config.enabled || !config.autoOffloadBrowser) {
    return payload;
  }

  const connectedNodes = deps.getConnectedNodes();
  const preferredNode = selectPreferredBrowserNode(connectedNodes);
  if (!preferredNode) {
    return payload;
  }

  if (DISCOVERY_METHODS.has(method)) {
    return routeDiscoveryRequest(payload, preferredNode, connectedNodes, deps);
  }

  if (method === 'browser.open_profile') {
    const profileId = stringField(payload, 'profileId');
    const profile = profileId ? deps.getProfile(profileId) : null;
    if (profile && !profile.executionNodeId) {
      throw localBrowserBlockedError(preferredNode);
    }
    return payload;
  }

  if (TARGET_SCOPED_METHODS.has(method)) {
    assertTargetIsRemote(payload, preferredNode, deps);
  }
  return payload;
}

function routeDiscoveryRequest(
  payload: Record<string, unknown>,
  preferredNode: WorkerNodeInfo,
  connectedNodes: WorkerNodeInfo[],
  deps: BrowserRemoteOffloadPolicyDeps,
): Record<string, unknown> {
  if (
    hasInvalidOptionalString(payload, 'nodeId')
    || hasInvalidOptionalString(payload, 'computer')
  ) {
    return payload;
  }

  const nodeId = stringField(payload, 'nodeId');
  const computer = stringField(payload, 'computer');
  if (!nodeId && !computer) {
    return withRemoteComputer(payload, preferredNode);
  }
  if (!computer) {
    return payload;
  }

  const computerOnly = resolveBrowserComputerTarget(
    { computer },
    { connectedNodes, descriptors: deps.listTargets() },
  );
  return computerOnly.ok && computerOnly.target.localOnly
    ? withRemoteComputer(payload, preferredNode)
    : payload;
}

function assertTargetIsRemote(
  payload: Record<string, unknown>,
  preferredNode: WorkerNodeInfo,
  deps: BrowserRemoteOffloadPolicyDeps,
): void {
  const targetId = stringField(payload, 'targetId');
  if (targetId) {
    const target = deps.listTargets().find((candidate) => candidate.id === targetId);
    if (target) {
      if (!target.nodeId) {
        throw localBrowserBlockedError(preferredNode);
      }
      return;
    }
  }

  const profileId = stringField(payload, 'profileId');
  const profile = profileId ? deps.getProfile(profileId) : null;
  if (profile && !profile.executionNodeId) {
    throw localBrowserBlockedError(preferredNode);
  }
}

function selectPreferredBrowserNode(nodes: WorkerNodeInfo[]): WorkerNodeInfo | undefined {
  const browserNodes = nodes.filter((node) => node.capabilities.hasBrowserMcp);
  const windowsNodes = browserNodes.filter((node) => node.capabilities.platform === 'win32');
  return matchNodeByCapabilityTag('browser-mcp', windowsNodes)
    ?? matchNodeByCapabilityTag('browser-mcp', browserNodes);
}

function withRemoteComputer(
  payload: Record<string, unknown>,
  node: WorkerNodeInfo,
): Record<string, unknown> {
  return {
    ...payload,
    nodeId: node.id,
    computer: node.name || node.id,
  };
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hasInvalidOptionalString(payload: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    return false;
  }
  const value = payload[key];
  return value !== undefined && (typeof value !== 'string' || value.length === 0);
}

function localBrowserBlockedError(node: WorkerNodeInfo): Error {
  const computer = node.name || node.id;
  return new Error(
    `browser_local_target_blocked_by_remote_auto_offload: Local browser control is disabled while remote browser auto-offload is enabled and "${computer}" is connected. Start with browser.find_or_open on "${computer}" and use the returned target.`,
  );
}
