import { getTailscaleIpv4Address, getTailscaleIpv6Address } from '../util/network-addresses';

export interface ResolvedBindHost {
  host: string;
  tailscaleIp: string | null;
}

/** No public-network fallback: a missing private interface must wait. */
export function resolveBindHost(bindInterface: 'tailscale' | 'all'): ResolvedBindHost | null {
  const tailscaleIp = getTailscaleIpv4Address() ?? getTailscaleIpv6Address();
  if (bindInterface === 'all') return { host: '0.0.0.0', tailscaleIp };
  return tailscaleIp ? { host: tailscaleIp, tailscaleIp } : null;
}
