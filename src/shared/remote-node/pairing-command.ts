/**
 * Builds the pairing link, `aio-worker pair` command and canonical connection
 * config for a one-time pairing credential. Shared by the Settings screen
 * (Copy Command, QR code) and the main-process `remote-nodes pair` /
 * `issue_remote_node_pairing` path, so both hand workers the same addresses.
 */

import { formatHostPort, isAllInterfacesHost } from './host-address';

export interface PairingCopyInput {
  token: string;
  label?: string;
  host: string;
  port: number;
  namespace: string;
  requireTls: boolean;
  /**
   * Other hosts the worker should try, in order, when `host` does not answer.
   * Sent as repeated `fallbackHost` link parameters and as `coordinatorUrls`
   * in the canonical config.
   */
  fallbackHosts?: string[];
}

export interface PairingEndpointStatus {
  port?: number;
  host?: string;
  localIps?: string[];
  tailscaleIp?: string | null;
  tailscaleIpv6?: string | null;
  tailscaleDnsName?: string | null;
}

export function buildCanonicalConnectionConfig(input: PairingCopyInput): Record<string, unknown> {
  const fallbackUrls = (input.fallbackHosts ?? []).map((host) => buildCoordinatorUrl({ ...input, host }));
  return {
    ...(input.label?.trim() ? { name: input.label.trim() } : {}),
    authToken: input.token,
    coordinatorUrl: buildCoordinatorUrl(input),
    ...(fallbackUrls.length > 0 ? { coordinatorUrls: fallbackUrls } : {}),
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
  // The worker reads `name` as its friendly name (`aio-worker pair --name` overrides it).
  const label = input.label?.trim();
  if (label) {
    params.set('name', label);
  }
  for (const host of input.fallbackHosts ?? []) {
    params.append('fallbackHost', host);
  }
  return `ai-orchestrator://remote-node/pair?${params.toString()}`;
}

export function buildPairingCommand(input: PairingCopyInput): string {
  return `aio-worker pair "${buildPairingLink(input)}"`;
}

export function buildCoordinatorUrl(input: Pick<PairingCopyInput, 'host' | 'port' | 'requireTls'>): string {
  return `${input.requireTls ? 'wss' : 'ws'}://${formatHostPort(input.host, input.port)}`;
}

export function selectPairingConnectionPort(
  status: PairingEndpointStatus,
  configuredPort: number,
): number {
  return status.port ?? configuredPort;
}

/**
 * The host a worker should dial first (MagicDNS name, then Tailscale IPv4 and
 * IPv6, then the best LAN IP), plus every other address this computer answers on.
 * Fallbacks exist only when the server listens on all interfaces; a server
 * bound to one address answers nowhere else.
 */
export function selectPairingConnectionHosts(
  status: PairingEndpointStatus,
  configuredHost: string,
): { host: string; fallbackHosts: string[] } {
  const bound = status.host ?? configuredHost;
  if (!isAllInterfacesHost(bound)) {
    return { host: bound, fallbackHosts: [] };
  }
  const candidates = [
    status.tailscaleDnsName,
    status.tailscaleIp,
    status.tailscaleIpv6,
    ...(status.localIps ?? []),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    .map((candidate) => candidate.trim());
  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    return { host: bound, fallbackHosts: [] };
  }
  return { host: unique[0], fallbackHosts: unique.slice(1) };
}
