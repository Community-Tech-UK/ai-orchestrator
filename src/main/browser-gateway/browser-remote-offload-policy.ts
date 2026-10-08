import type { BrowserProfile, BrowserTarget } from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { getRemoteAuthService } from '../auth/remote-auth';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import {
  getWorkerNodeRegistry,
  matchNodeByCapabilityTag,
} from '../remote-node/worker-node-registry';
import { getBrowserProfileStore } from './browser-profile-store';
import { getBrowserTargetRegistry } from './browser-target-registry';

interface BrowserRemoteOffloadConfig {
  enabled: boolean;
  autoOffloadBrowser: boolean;
}

/** A paired node that has reported browser automation (sticky until unpaired). */
export interface KnownBrowserComputer {
  id: string;
  name: string;
}

export interface BrowserRemoteOffloadPolicyDeps {
  getConfig: () => BrowserRemoteOffloadConfig;
  getConnectedNodes: () => WorkerNodeInfo[];
  /** Paired browser computers, connected or not (persisted, sticky until unpaired). */
  getKnownBrowserComputers: () => KnownBrowserComputer[];
  listTargets: () => BrowserTarget[];
  getProfile: (profileId: string) => BrowserProfile | null;
}

const DISCOVERY_METHODS = new Set([
  'browser.list_targets',
  'browser.preflight_target',
  'browser.find_or_open',
  'browser.close_matching',
  'browser.recover_extension',
]);

const TARGET_SCOPED_METHODS = new Set([
  'browser.select_target',
  'browser.navigate',
  'browser.reload',
  'browser.close_tab',
  'browser.click',
  'browser.type',
  'browser.fill_form',
  'browser.select',
  'browser.execute_fill_plan',
  'browser.fill_credential',
  'browser.request_credential_access',
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

/** Paired nodes that have reported browser automation, connected or not. */
export function listKnownBrowserComputers(): KnownBrowserComputer[] {
  return getRemoteAuthService().listSessions()
    .filter((session) => session.browserCapable === true)
    .map((session) => ({ id: session.nodeId, name: session.nodeName }));
}

const defaultDeps: BrowserRemoteOffloadPolicyDeps = {
  getConfig: getRemoteNodeConfig,
  getConnectedNodes: () => getWorkerNodeRegistry().getHealthyNodes(),
  getKnownBrowserComputers: listKnownBrowserComputers,
  listTargets: () => getBrowserTargetRegistry().listTargets(),
  getProfile: (profileId) => getBrowserProfileStore().getProfile(profileId),
};

/**
 * Enforce the remote-browser preference at the authenticated Browser Gateway
 * boundary. Unscoped discovery is routed to a connected browser-capable
 * worker. An explicit `computer: "local"` stays local — remapping it made
 * remote-node failures look like a broken coordinator channel.
 *
 * Calls that already carry a coordinator-local target/profile are rejected
 * because a target id is machine-specific and cannot safely be rewritten to a
 * different computer.
 *
 * When no browser computer is usable but one is paired, unscoped discovery
 * and local managed-profile opens are refused instead of silently running on
 * this Mac (2026-10-07: the Windows PC dropped and browser work took over the
 * user's mouse and keyboard). An explicit `computer: "local"` still runs: that
 * is how an agent proceeds once the user has agreed.
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
    return guardOfflineBrowserComputer(method, payload, deps);
  }

  if (DISCOVERY_METHODS.has(method)) {
    return routeDiscoveryRequest(payload, preferredNode);
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
  return payload;
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

/**
 * No connected node can take browser work. A paired browser computer that is
 * disconnected, or connected without browser automation, is equally unable to
 * — so any known browser computer means "do not fall back silently".
 */
function guardOfflineBrowserComputer(
  method: string,
  payload: Record<string, unknown>,
  deps: BrowserRemoteOffloadPolicyDeps,
): Record<string, unknown> {
  const offline = deps.getKnownBrowserComputers();
  if (offline.length === 0) {
    return payload;
  }

  if (DISCOVERY_METHODS.has(method)) {
    if (
      hasInvalidOptionalString(payload, 'nodeId')
      || hasInvalidOptionalString(payload, 'computer')
      || stringField(payload, 'nodeId')
      || stringField(payload, 'computer')
    ) {
      return payload;
    }
    throw browserComputerOfflineError(offline, 'retry with computer: "local"');
  }

  if (method === 'browser.open_profile') {
    const profileId = stringField(payload, 'profileId');
    const profile = profileId ? deps.getProfile(profileId) : null;
    if (profile && !profile.executionNodeId) {
      // open_profile has no computer selector, so there is no explicit-local
      // form; the agreed path is find_or_open on the user's own Chrome.
      throw browserComputerOfflineError(offline, 'use browser.find_or_open with computer: "local"');
    }
  }
  return payload;
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

function browserComputerOfflineError(offline: KnownBrowserComputer[], agreedPath: string): Error {
  const names = offline.map((computer) => `"${computer.name || computer.id}"`).join(', ');
  return new Error(
    `browser_remote_computer_offline: The browser computer ${names} is offline or not ready for browser work, so this request did not run. `
    + 'Do not use this Mac\'s browser instead on your own. Tell the user it is unavailable and ask whether to use this Mac, '
    + `wait for it to come back, or skip the browser step. Only if the user agrees to this Mac, ${agreedPath}.`,
  );
}

function localBrowserBlockedError(node: WorkerNodeInfo): Error {
  const computer = node.name || node.id;
  return new Error(
    `browser_local_target_blocked_by_remote_auto_offload: Local browser control is disabled while remote browser auto-offload is enabled and "${computer}" is connected. Start with browser.find_or_open on "${computer}" and use the returned target.`,
  );
}
