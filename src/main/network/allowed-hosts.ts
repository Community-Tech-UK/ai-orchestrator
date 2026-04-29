export interface AllowedHostsConfig {
  allowPrivateRanges: boolean;
  extraAllowedHosts?: string[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

export class AllowedHostMatcher {
  private readonly extra: Set<string>;

  constructor(private readonly cfg: AllowedHostsConfig) {
    this.extra = new Set((cfg.extraAllowedHosts ?? []).map(normalizeHostname));
  }

  isAllowed(hostname: string | undefined): boolean {
    if (!hostname) return false;

    const normalized = normalizeHostname(hostname);
    if (LOOPBACK.has(normalized)) return true;
    if (this.extra.has(normalized)) return true;
    return this.cfg.allowPrivateRanges && isPrivateIPv4(normalized);
  }
}
