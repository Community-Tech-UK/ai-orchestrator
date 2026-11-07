import { isAllInterfacesHost } from '../../shared/remote-node/host-address';
import { orderCoordinatorHosts, readCoordinatorReachableHosts } from './coordinator-advertised-urls';

/** Mirrors the candidate schema's limit on `addresses`. */
const MAX_PAIR_BOTH_ADDRESSES = 16;

/**
 * Every host the other computer may use to reach this one, best first. A server
 * bound to one address answers nowhere else. Otherwise: MagicDNS name (only
 * while Tailscale runs), Tailscale IPv4, Tailscale IPv6, then LAN addresses.
 * Read without blocking the main thread on the Tailscale CLI.
 */
export async function listReachableHosts(configuredHost: string): Promise<string[]> {
  if (!isAllInterfacesHost(configuredHost)) {
    return [configuredHost];
  }
  const hosts = orderCoordinatorHosts(configuredHost, await readCoordinatorReachableHosts());
  return hosts.length > 0 ? hosts.slice(0, MAX_PAIR_BOTH_ADDRESSES) : ['127.0.0.1'];
}
