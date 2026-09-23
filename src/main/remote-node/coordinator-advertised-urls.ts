import {
  getLocalIpv4Addresses,
  getTailscaleIpv4Address,
  readTailscaleSelfStatus,
  type TailscaleSelfStatus,
} from '../util/network-addresses';
import type { RemoteNodeConfig } from './remote-node-config';

/** Upper bound on URLs sent to a worker; mirrors the RPC schema's limit. */
export const MAX_ADVERTISED_COORDINATOR_URLS = 16;

export interface CoordinatorUrlHosts {
  tailscaleDnsName: string | null;
  tailscaleIp: string | null;
  localIps: string[];
}

/**
 * Every address a worker could use to reach this coordinator, best-first and
 * de-duplicated: Tailscale MagicDNS name, Tailscale IP, then ranked LAN IPs,
 * then an explicitly configured bind host.
 */
export function buildCoordinatorUrls(
  config: Pick<RemoteNodeConfig, 'serverHost' | 'serverPort' | 'tlsCertPath' | 'tlsKeyPath'>,
  hosts: CoordinatorUrlHosts,
): string[] {
  const protocol = config.tlsCertPath && config.tlsKeyPath ? 'wss' : 'ws';
  const candidates = [
    hosts.tailscaleDnsName,
    hosts.tailscaleIp,
    ...hosts.localIps,
    config.serverHost !== '0.0.0.0' ? config.serverHost : null,
  ].filter((host): host is string => typeof host === 'string' && host.trim().length > 0);

  const urls: string[] = [];
  for (const host of candidates) {
    const url = `${protocol}://${host.trim()}:${config.serverPort}`;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, MAX_ADVERTISED_COORDINATOR_URLS);
}

export interface ResolveAdvertisedUrlsDeps {
  readTailscaleStatus?: () => Promise<TailscaleSelfStatus | null>;
  getTailscaleIp?: () => string | null;
  getLocalIps?: () => string[];
}

/**
 * Current coordinator URLs for advertising to a connected worker. Async so the
 * MagicDNS lookup (a CLI call) never blocks registration.
 *
 * The MagicDNS name is only included while Tailscale is actually running; a
 * stopped backend still reports its last name, and advertising it would hand
 * the worker a route that cannot currently answer.
 */
export async function resolveAdvertisedCoordinatorUrls(
  config: Pick<RemoteNodeConfig, 'serverHost' | 'serverPort' | 'tlsCertPath' | 'tlsKeyPath'>,
  deps: ResolveAdvertisedUrlsDeps = {},
): Promise<string[]> {
  const tailscaleIp = (deps.getTailscaleIp ?? getTailscaleIpv4Address)();
  const status = tailscaleIp ? await (deps.readTailscaleStatus ?? readTailscaleSelfStatus)() : null;
  return buildCoordinatorUrls(config, {
    tailscaleDnsName: status?.backendState === 'Running' ? status.dnsName : null,
    tailscaleIp,
    localIps: (deps.getLocalIps ?? getLocalIpv4Addresses)(),
  });
}
