/**
 * Pure data shapes + helpers for the Remote Nodes settings tab's browser
 * automation UI. Extracted from the component to keep it under the size ratchet
 * and to make the badge/login logic independently testable.
 */
import type {
  WorkerNodeInfo,
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeAndroidAutomationSummary,
  WorkerNodeExtensionRelaySummary,
  NodePlatform,
} from '../../../../shared/types/worker-node.types';
import { buildBrowserLoginCommand } from '../../../../shared/utils/browser-login-command';

export interface RegisteredNodeRecord {
  sessionId?: string;
  nodeId?: string;
  nodeName?: string;
  transportToken?: string;
  token?: string;
  issuedAt?: number;
  createdAt?: number;
  lastSeenAt?: number;
  authMethod?: 'pairing_credential' | 'manual_pairing';
  pairingLabel?: string;
  platform?: NodePlatform;
}

export interface NodeHealthEntry {
  id: string;
  name: string;
  status: WorkerNodeInfo['status'];
  address?: string;
  createdAt?: number;
  connectedAt?: number;
  lastHeartbeat?: number;
  lastSeenAt?: number;
  pairingLabel?: string;
  platform?: NodePlatform;
  supportsBrowser: boolean;
  /** Browser automation wired & ready on the node (chrome-devtools MCP). */
  browserAutomationReady: boolean;
  /** Non-secret summary of the node's browser-automation config, if reported. */
  browserAutomation?: WorkerNodeBrowserAutomationSummary;
  /** Chrome extension relay wired and listening on the worker. */
  extensionRelayReady: boolean;
  /** Non-secret extension relay state, if reported. */
  extensionRelay?: WorkerNodeExtensionRelaySummary;
  /** Android automation wired & ready on the node (mobile-mcp injection). */
  androidAutomationReady: boolean;
  /** Android SDK/device state reported by newer worker nodes. */
  androidAutomation?: WorkerNodeAndroidAutomationSummary;
  supportsGpu: boolean;
  supportedClis: string[];
}

export function buildNodeHealthEntries(
  registeredNodes: Record<string, RegisteredNodeRecord>,
  liveNodes: WorkerNodeInfo[],
): NodeHealthEntry[] {
  const liveById = new Map(liveNodes.map((node) => [node.id, node]));
  const ids = new Set<string>([
    ...Object.keys(registeredNodes),
    ...liveById.keys(),
  ]);
  const rank: Record<WorkerNodeInfo['status'], number> = {
    connected: 0,
    degraded: 1,
    connecting: 2,
    disconnected: 3,
  };

  return [...ids]
    .map((id) => {
      const registered = registeredNodes[id];
      const live = liveById.get(id);
      return {
        id,
        name: live?.name ?? registered?.nodeName ?? id,
        status: live?.status ?? 'disconnected',
        address: live?.address,
        createdAt: registered?.issuedAt ?? registered?.createdAt,
        connectedAt: live?.connectedAt,
        lastHeartbeat: live?.lastHeartbeat,
        lastSeenAt: registered?.lastSeenAt,
        pairingLabel: registered?.pairingLabel,
        platform: live?.capabilities.platform ?? registered?.platform,
        supportsBrowser: live?.capabilities.hasBrowserRuntime ?? false,
        browserAutomationReady: live?.capabilities.hasBrowserMcp ?? false,
        browserAutomation: live?.capabilities.browserAutomation,
        extensionRelayReady: live?.capabilities.hasExtensionRelay ?? false,
        extensionRelay: live?.capabilities.extensionRelay,
        androidAutomationReady: live?.capabilities.hasAndroidMcp ?? false,
        androidAutomation: live?.capabilities.androidAutomation,
        supportsGpu: Boolean(live?.capabilities.gpuName),
        supportedClis: live?.capabilities.supportedClis ?? [],
      };
    })
    .sort((left, right) => {
      const statusDiff = rank[left.status] - rank[right.status];
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return left.name.localeCompare(right.name);
    });
}

export type BrowserAutomationState = 'ready' | 'enabled' | 'chrome-only' | 'off';
export type ExtensionRelayState = 'ready' | 'enabled' | 'off';

/**
 * Three-state-plus readiness for a node:
 *  - `ready`       — enabled AND the managed Chrome is verified up right now
 *  - `enabled`     — enabled but Chrome hasn't launched yet (lazy on first use)
 *  - `chrome-only` — Chrome installed but automation not enabled
 *  - `off`         — no Chrome runtime detected
 */
export function browserAutomationState(entry: NodeHealthEntry): BrowserAutomationState {
  if (entry.browserAutomationReady) {
    return entry.browserAutomation?.running ? 'ready' : 'enabled';
  }
  return entry.supportsBrowser ? 'chrome-only' : 'off';
}

export function browserAutomationLabel(entry: NodeHealthEntry): string {
  switch (browserAutomationState(entry)) {
    case 'ready':
      return 'Browser automation: ready';
    case 'enabled':
      return 'Browser automation: enabled (starts on first use)';
    case 'chrome-only':
      return 'Browser automation: Chrome only';
    default:
      return 'Browser automation: off';
  }
}

export function extensionRelayState(entry: NodeHealthEntry): ExtensionRelayState {
  if (entry.extensionRelayReady) {
    return 'ready';
  }
  return entry.extensionRelay?.enabled ? 'enabled' : 'off';
}

export function extensionRelayLabel(entry: NodeHealthEntry): string {
  switch (extensionRelayState(entry)) {
    case 'ready':
      return 'Extension relay: ready';
    case 'enabled':
      return 'Extension relay: enabled';
    default:
      return 'Extension relay: off';
  }
}

export type AndroidAutomationState = 'ready' | 'enabled' | 'sdk-only' | 'off';

export function androidAutomationState(entry: NodeHealthEntry): AndroidAutomationState {
  if (entry.androidAutomationReady) {
    if (hasOnlineAndroidDevice(entry) || entry.androidAutomation?.emulatorRunning) {
      return 'ready';
    }
    if (!entry.androidAutomation || hasConfiguredAndroidTarget(entry)) {
      return 'enabled';
    }
  }
  return entry.androidAutomation?.adbVersion ? 'sdk-only' : 'off';
}

export function androidAutomationLabel(entry: NodeHealthEntry): string {
  switch (androidAutomationState(entry)) {
    case 'ready':
      return 'Android automation: ready';
    case 'enabled':
      return 'Android automation: enabled (starts emulator on first use)';
    case 'sdk-only':
      return 'Android automation: SDK detected';
    default:
      return 'Android automation: off';
  }
}

export function withPatchedBrowserAutomation(
  nodes: WorkerNodeInfo[],
  nodeId: string,
  summary: WorkerNodeBrowserAutomationSummary,
): WorkerNodeInfo[] {
  return nodes.map((node) =>
    node.id === nodeId
      ? {
          ...node,
          capabilities: {
            ...node.capabilities,
            browserAutomation: summary,
            hasBrowserMcp: summary.enabled && node.capabilities.hasBrowserRuntime,
          },
        }
      : node,
  );
}

export function withPatchedAndroidAutomation(
  nodes: WorkerNodeInfo[],
  nodeId: string,
  summary: WorkerNodeAndroidAutomationSummary,
): WorkerNodeInfo[] {
  return nodes.map((node) =>
    node.id === nodeId
      ? {
          ...node,
          capabilities: {
            ...node.capabilities,
            androidAutomation: summary,
            hasAndroidMcp: summary.enabled && Boolean(summary.adbVersion),
          },
        }
      : node,
  );
}

export function withPatchedExtensionRelay(
  nodes: WorkerNodeInfo[],
  nodeId: string,
  summary: WorkerNodeExtensionRelaySummary,
): WorkerNodeInfo[] {
  return nodes.map((node) =>
    node.id === nodeId
      ? {
          ...node,
          capabilities: {
            ...node.capabilities,
            extensionRelay: summary,
            hasExtensionRelay: summary.enabled && summary.running,
          },
        }
      : node,
  );
}

function hasOnlineAndroidDevice(entry: NodeHealthEntry): boolean {
  return entry.androidAutomation?.connectedDevices.some((device) => device.state === 'device') ?? false;
}

function hasConfiguredAndroidTarget(entry: NodeHealthEntry): boolean {
  const summary = entry.androidAutomation;
  return Boolean(summary && (summary.avds.length > 0 || summary.defaultAvd));
}

/**
 * The exact login command "Run on node" would execute for the node's reported
 * profile + platform. Empty until the profile has been applied (so the preview
 * matches what runs). Returns '' on any unsafe/unknown input rather than throwing.
 */
export function loginCommandPreview(entry: NodeHealthEntry, url: string): string {
  const profileDir = entry.browserAutomation?.profileDir;
  if (!profileDir || !entry.platform) {
    return '';
  }
  try {
    return buildBrowserLoginCommand(entry.platform, profileDir, url).command;
  } catch {
    return '';
  }
}
