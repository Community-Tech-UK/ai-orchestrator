import {
  getLocalIpv4Addresses,
  getTailscaleIpv4Address,
  getTailscaleIpv6Address,
  readTailscaleSelfStatus,
  type TailscaleSelfStatus,
} from '../util/network-addresses';
import { formatHostForUrl, isAllInterfacesHost } from '../../shared/remote-node/host-address';
import type { RemoteNodeConfig } from './remote-node-config';

/** Upper bound on URLs sent to a worker; mirrors the RPC schema's limit. */
export const MAX_ADVERTISED_COORDINATOR_URLS = 16;

export interface CoordinatorUrlHosts {
  tailscaleDnsName: string | null;
  tailscaleIp: string | null;
  tailscaleIpv6?: string | null;
  localIps: string[];
}

/**
 * Every host a worker could use to reach this coordinator, best-first and
 * de-duplicated: Tailscale MagicDNS name, Tailscale IPv4, Tailscale IPv6, then
 * ranked LAN IPs, then an explicitly configured bind host.
 */
export function orderCoordinatorHosts(serverHost: string, hosts: CoordinatorUrlHosts): string[] {
  const candidates = [
    hosts.tailscaleDnsName,
    hosts.tailscaleIp,
    hosts.tailscaleIpv6,
    ...hosts.localIps,
    !isAllInterfacesHost(serverHost) ? serverHost : null,
  ].filter((host): host is string => typeof host === 'string' && host.trim().length > 0)
    .map((host) => host.trim());
  return [...new Set(candidates)];
}

/** The same hosts as URLs. IPv6 hosts are bracketed, as a URL requires. */
export function buildCoordinatorUrls(
  config: Pick<RemoteNodeConfig, 'serverHost' | 'serverPort' | 'tlsCertPath' | 'tlsKeyPath'>,
  hosts: CoordinatorUrlHosts,
): string[] {
  const protocol = config.tlsCertPath && config.tlsKeyPath ? 'wss' : 'ws';
  return orderCoordinatorHosts(config.serverHost, hosts)
    .map((host) => `${protocol}://${formatHostForUrl(host)}:${config.serverPort}`)
    .slice(0, MAX_ADVERTISED_COORDINATOR_URLS);
}

export interface ReadReachableHostsDeps {
  readTailscaleStatus?: () => Promise<TailscaleSelfStatus | null>;
  getTailscaleIp?: () => string | null;
  getTailscaleIpv6?: () => string | null;
  getLocalIps?: () => string[];
}

export type ResolveAdvertisedUrlsDeps = ReadReachableHostsDeps;

/**
 * Every host this computer answers on right now. Async so the MagicDNS lookup
 * (a CLI call) never blocks the main thread.
 *
 * The MagicDNS name is only included while Tailscale is actually running; a
 * stopped backend still reports its last name, and advertising it would hand
 * the worker a route that cannot currently answer.
 */
export async function readCoordinatorReachableHosts(
  deps: ReadReachableHostsDeps = {},
): Promise<Required<CoordinatorUrlHosts>> {
  const tailscaleIp = (deps.getTailscaleIp ?? getTailscaleIpv4Address)();
  const tailscaleIpv6 = (deps.getTailscaleIpv6 ?? getTailscaleIpv6Address)();
  const status = tailscaleIp || tailscaleIpv6
    ? await (deps.readTailscaleStatus ?? readTailscaleSelfStatus)()
    : null;
  return {
    tailscaleDnsName: status?.backendState === 'Running' ? status.dnsName : null,
    tailscaleIp,
    tailscaleIpv6,
    localIps: (deps.getLocalIps ?? getLocalIpv4Addresses)(),
  };
}

/** Current coordinator URLs for advertising to a connected worker. */
export async function resolveAdvertisedCoordinatorUrls(
  config: Pick<RemoteNodeConfig, 'serverHost' | 'serverPort' | 'tlsCertPath' | 'tlsKeyPath'>,
  deps: ResolveAdvertisedUrlsDeps = {},
): Promise<string[]> {
  return buildCoordinatorUrls(config, await readCoordinatorReachableHosts(deps));
}
