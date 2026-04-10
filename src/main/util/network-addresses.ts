import * as os from 'os';

/**
 * Returns all non-internal IPv4 addresses on this machine.
 * Useful for showing workers which IP to connect to.
 */
export function getLocalIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];

  for (const values of Object.values(interfaces)) {
    for (const iface of values || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }

  return ips;
}
