import type { NodeHealthEntry } from './remote-nodes-browser-automation';
import type { NodePlatform } from '../../../../shared/types/worker-node.types';
import { formatRemoteNodePlatformLabel } from '../../shared/remote-node-display';

export interface PairingCopyInput {
  token: string;
  label?: string;
  host: string;
  port: number;
  namespace: string;
  requireTls: boolean;
}

export interface PairingEndpointStatus {
  port?: number;
  host?: string;
  localIps?: string[];
  tailscaleIp?: string | null;
  tailscaleDnsName?: string | null;
}

export function buildCanonicalConnectionConfig(input: PairingCopyInput): Record<string, unknown> {
  return {
    ...(input.label?.trim() ? { name: input.label.trim() } : {}),
    authToken: input.token,
    coordinatorUrl: buildCoordinatorUrl(input),
    namespace: input.namespace,
    maxConcurrentInstances: 10,
    workingDirectories: [],
  };
}

export function buildPairingLink(input: PairingCopyInput): string {
  const params = new URLSearchParams({
    host: input.host,
    port: String(input.port),
    namespace: input.namespace,
    token: input.token,
    requireTls: String(input.requireTls),
  });
  return `ai-orchestrator://remote-node/pair?${params.toString()}`;
}

export function buildPairingCommand(input: PairingCopyInput): string {
  return `aio-worker pair "${buildPairingLink(input)}"`;
}

export function buildCoordinatorUrl(input: Pick<PairingCopyInput, 'host' | 'port' | 'requireTls'>): string {
  return `${input.requireTls ? 'wss' : 'ws'}://${input.host}:${input.port}`;
}

export function selectPairingConnectionPort(
  status: PairingEndpointStatus,
  configuredPort: number,
): number {
  return status.port ?? configuredPort;
}

export function selectPairingConnectionHost(
  status: PairingEndpointStatus,
  configuredHost: string,
): string {
  const host = status.host ?? configuredHost;
  if (host === '0.0.0.0' && status.tailscaleDnsName) {
    return status.tailscaleDnsName;
  }
  if (host === '0.0.0.0' && status.tailscaleIp) {
    return status.tailscaleIp;
  }
  const localIps = status.localIps ?? [];
  return host === '0.0.0.0' && localIps.length > 0 ? localIps[0] : host;
}

export function buildNodeDiagnostics(entry: NodeHealthEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    status: entry.status,
    platform: entry.platform ?? null,
    address: entry.address ?? null,
    connectedAt: entry.connectedAt ?? null,
    lastHeartbeat: entry.lastHeartbeat ?? null,
    lastAuthenticatedAt: entry.lastSeenAt ?? null,
    pairingLabel: entry.pairingLabel ?? null,
    capabilities: {
      supportedClis: entry.supportedClis,
      hasBrowserRuntime: entry.supportsBrowser,
      hasBrowserMcp: entry.browserAutomationReady,
      hasAndroidMcp: entry.androidAutomationReady,
      hasDocker: entry.hasDocker,
      hasGpu: entry.supportsGpu,
    },
    capacity: {
      activeInstances: entry.activeInstances,
      maxConcurrentInstances: entry.maxConcurrentInstances,
    },
    workingDirectories: entry.workingDirectories,
  };
}

export function formatPairingCredentialLabel(input: { label?: string }): string {
  return input.label?.trim() || 'Unlabeled credential';
}

export function formatNodePlatformLabel(platform: NodePlatform | undefined): string {
  const label = formatRemoteNodePlatformLabel(platform);
  return label === 'Unknown' ? 'Platform unknown' : label;
}

export function formatNodeCapacity(
  entry: Pick<NodeHealthEntry, 'activeInstances' | 'maxConcurrentInstances'>,
): string {
  return `${entry.activeInstances}/${entry.maxConcurrentInstances} capacity`;
}

/** Formats a future timestamp (e.g. a pairing credential's expiry) as "in Nm/Nh/Nd" or "now". */
export function formatExpiry(timestamp: number): string {
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) {
    return 'now';
  }

  const remainingMinutes = Math.round(remainingMs / 60_000);
  if (remainingMinutes < 60) {
    return `in ${remainingMinutes}m`;
  }

  const remainingHours = Math.round(remainingMinutes / 60);
  if (remainingHours < 48) {
    return `in ${remainingHours}h`;
  }

  const remainingDays = Math.round(remainingHours / 24);
  return `in ${remainingDays}d`;
}

/** Formats a past timestamp (e.g. last-seen/registered) as "Nm/Nh/Nd ago", "just now", or "never". */
export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return 'never';
  }

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) {
    return 'just now';
  }

  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}
