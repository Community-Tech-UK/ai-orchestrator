import type { BrowserProfile, BrowserTarget } from '@contracts/types/browser';
import type { ComputerChoice } from '../../shared/types/settings.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { getRemoteAuthService } from '../auth/remote-auth';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { BrowserComputerBalancer, browserComputers, originOf } from './browser-computer-balancer';
import { resolveBrowserComputerTarget } from './browser-computer-target';
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
  /** The Computers page's order and pauses. */
  getComputerChoices: () => readonly ComputerChoice[];
  balancer: BrowserComputerBalancer;
  now: () => number;
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
  'browser.press_key',
  'browser.set_viewport',
  'browser.set_zoom',
  'browser.handle_dialog',
  'browser.execute_fill_plan',
  'browser.fill_credential',
  'browser.fill_http_auth',
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
  getComputerChoices: () => getWorkerNodeRegistry().getComputerChoices(),
  balancer: new BrowserComputerBalancer(),
  now: Date.now,
};

/**
 * Enforce the remote-browser preference at the authenticated Browser Gateway
 * boundary. Unscoped discovery is routed to a connected browser-capable
 * worker, chosen per session by BrowserComputerBalancer so sessions spread
 * across the browser computers and each keeps to one. An explicit
 * `computer: "local"` stays local — remapping it made
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
  instanceId: string,
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
  const computers = browserComputers(connectedNodes);
  if (computers.length === 0) {
    return guardOfflineBrowserComputer(method, payload, deps);
  }
  const now = deps.now();
  // Named only in errors: the computer this session is on, or any that could take it.
  const preferredNode = deps.balancer.current(instanceId, computers, now) ?? computers[0]!;

  if (DISCOVERY_METHODS.has(method)) {
    return routeDiscoveryRequest(payload, instanceId, connectedNodes, deps, now);
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
    assertTargetIsRemote(payload, instanceId, preferredNode, deps, now);
  }
  return payload;
}

function routeDiscoveryRequest(
  payload: Record<string, unknown>,
  instanceId: string,
  connectedNodes: WorkerNodeInfo[],
  deps: BrowserRemoteOffloadPolicyDeps,
  now: number,
): Record<string, unknown> {
  if (
    hasInvalidOptionalString(payload, 'nodeId')
    || hasInvalidOptionalString(payload, 'computer')
  ) {
    return payload;
  }

  const nodeId = stringField(payload, 'nodeId');
  const computer = stringField(payload, 'computer');
  if (nodeId || computer) {
    // A named computer is obeyed exactly, and the session keeps to it when it next names none.
    const named = namedNodeId(nodeId, computer, connectedNodes);
    if (named) deps.balancer.noteUse(instanceId, named, now);
    return payload;
  }
  const chosen = deps.balancer.choose({
    instanceId,
    nodes: connectedNodes,
    choices: deps.getComputerChoices(),
    targets: deps.listTargets(),
    origin: originOf(payload['url']),
    now,
  });
  if (!chosen) throw browserComputersPausedError(connectedNodes);
  return withRemoteComputer(payload, chosen);
}

/**
 * The connected computer a request names, as it will resolve; none for `local`, for a name or id that matches no
 * connected computer, or for an id and a name that disagree, which the request itself will refuse.
 */
function namedNodeId(nodeId: string | undefined, computer: string | undefined, connectedNodes: WorkerNodeInfo[]): string | undefined {
  const resolved = resolveBrowserComputerTarget({ nodeId, computer }, { connectedNodes });
  const id = resolved.ok ? resolved.target.nodeId : undefined;
  return connectedNodes.some(node => node.id === id) ? id : undefined;
}

function assertTargetIsRemote(
  payload: Record<string, unknown>,
  instanceId: string,
  preferredNode: WorkerNodeInfo,
  deps: BrowserRemoteOffloadPolicyDeps,
  now: number,
): void {
  const targetId = stringField(payload, 'targetId');
  if (targetId) {
    const target = deps.listTargets().find((candidate) => candidate.id === targetId);
    if (target) {
      if (!target.nodeId) {
        throw localBrowserBlockedError(preferredNode);
      }
      deps.balancer.noteUse(instanceId, target.nodeId, now);
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

function browserComputersPausedError(connectedNodes: WorkerNodeInfo[]): Error {
  const names = browserComputers(connectedNodes).map(node => `"${node.name || node.id}"`).join(', ');
  return new Error(
    `browser_computers_paused: Every browser computer (${names}) is paused on the Computers page, so this request did not run. `
    + 'Do not use this Mac\'s browser instead on your own. Tell the user and ask whether to unpause one, name one anyway, '
    + 'use this Mac, or skip the browser step.',
  );
}

function localBrowserBlockedError(node: WorkerNodeInfo): Error {
  const computer = node.name || node.id;
  return new Error(
    `browser_local_target_blocked_by_remote_auto_offload: Local browser control is disabled while remote browser auto-offload is enabled and "${computer}" is connected. Start with browser.find_or_open on "${computer}" and use the returned target.`,
  );
}
