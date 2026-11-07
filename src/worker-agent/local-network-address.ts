import * as net from 'net';

/**
 * Addresses macOS treats as the local network: private IPv4 ranges, IPv4
 * link-local, and IPv6 link-local and unique-local, except Tailscale's own
 * range, which goes through its tunnel rather than the local network.
 */
export function isLocalNetworkAddress(address: string): boolean {
  const plain = address.replace(/^::ffff:/i, '');
  if (net.isIPv4(plain)) {
    const [a, b] = plain.split('.').map((part) => Number.parseInt(part, 10));
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (net.isIPv6(plain)) {
    const lower = plain.toLowerCase();
    if (lower.startsWith('fd7a:115c:a1e0:')) {
      return false;
    }
    return /^fe[89ab]/.test(lower) || /^f[cd]/.test(lower);
  }
  return false;
}
