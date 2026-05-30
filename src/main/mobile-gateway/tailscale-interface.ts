import * as os from 'os';
import { getLogger } from '../logging/logger';

const logger = getLogger('MobileGateway');

/**
 * Tailscale assigns every node an IPv4 in the 100.64.0.0/10 CGNAT range. The OS
 * interface name varies (`tailscale0` on Linux, `utunN` on macOS), so we detect
 * by address range rather than interface name.
 */
export function resolveTailscaleIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      const isIpv4 = addr.family === 'IPv4' || (addr.family as unknown as number) === 4;
      if (isIpv4 && !addr.internal && isCgnat(addr.address)) {
        return addr.address;
      }
    }
  }
  return null;
}

function isCgnat(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return false;
  }
  // 100.64.0.0 – 100.127.255.255
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export interface ResolvedBindHost {
  host: string;
  tailscaleIp: string | null;
}

/**
 * Resolve the host the gateway should bind to.
 * - `'tailscale'` → the Tailscale interface IP, so the gateway is reachable only
 *   over the tailnet (not the LAN). Falls back to `0.0.0.0` with a warning if no
 *   Tailscale interface is found (token auth still applies).
 * - `'all'` → `0.0.0.0` (token auth is the only protection; use behind a firewall).
 */
export function resolveBindHost(bindInterface: 'tailscale' | 'all'): ResolvedBindHost {
  const tailscaleIp = resolveTailscaleIpv4();
  if (bindInterface === 'all') {
    return { host: '0.0.0.0', tailscaleIp };
  }
  if (tailscaleIp) {
    return { host: tailscaleIp, tailscaleIp };
  }
  logger.warn(
    'Tailscale interface not found; binding 0.0.0.0 (token auth still required). Is Tailscale running on this machine?',
  );
  return { host: '0.0.0.0', tailscaleIp: null };
}
