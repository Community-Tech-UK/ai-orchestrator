/**
 * Small helpers for host addresses that may be IPv4, IPv6 or a name. Shared by
 * the coordinator (URLs it advertises, listeners it opens) and the worker
 * (links it reads), so every URL builder treats IPv6 the same way.
 */

/** The "listen on every interface" values a server host setting can hold. */
export function isAllInterfacesHost(host: string): boolean {
  const normalized = host.trim();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

/**
 * The address to listen on for a host setting. The IPv4 wildcard becomes the
 * IPv6 wildcard, which also takes IPv4 peers (as IPv4-mapped addresses), so one
 * listener answers on both. The setting itself stays `0.0.0.0`.
 */
export function toListenHost(host: string): string {
  return host.trim() === '0.0.0.0' ? '::' : host;
}

/** `::ffff:192.168.1.5` is how a dual-stack listener reports an IPv4 peer. */
export function stripIpv4MappedPrefix(address: string): string {
  return address.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
}

/** A host as it must appear in a URL: IPv6 literals get square brackets. */
export function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[')) return trimmed;
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed;
}

export function formatHostPort(host: string, port: number): string {
  return `${formatHostForUrl(host)}:${port}`;
}
