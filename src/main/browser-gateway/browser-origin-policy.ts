import type { BrowserAllowedOrigin } from '@contracts/types/browser';

export interface BrowserNormalizedOrigin {
  scheme: 'https' | 'http';
  host: string;
  port: number;
  origin: string;
}

export type BrowserOriginDenyReason =
  | 'invalid_url'
  | 'host_not_allowed'
  | 'scheme_not_allowed'
  | 'port_not_allowed';

export type BrowserOriginDecision =
  | {
      allowed: true;
      origin: string;
      matchedOrigin: BrowserAllowedOrigin;
    }
  | {
      allowed: false;
      origin?: string;
      reason: BrowserOriginDenyReason;
    };

function defaultPort(scheme: 'https' | 'http'): number {
  return scheme === 'https' ? 443 : 80;
}

function normalizeHostPattern(hostPattern: string): string {
  return hostPattern.toLowerCase().replace(/^\*\./, '');
}

function hostMatches(host: string, allowed: BrowserAllowedOrigin): boolean {
  const hostPattern = normalizeHostPattern(allowed.hostPattern);
  if (host === hostPattern) {
    return true;
  }
  if (!allowed.includeSubdomains) {
    return false;
  }
  return host.endsWith(`.${hostPattern}`);
}

export function normalizeOrigin(input: string): BrowserNormalizedOrigin | null {
  try {
    const parsed = new URL(input);
    const scheme = parsed.protocol.replace(':', '');
    if (scheme !== 'https' && scheme !== 'http') {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : defaultPort(scheme);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return {
      scheme,
      host,
      port,
      origin: parsed.origin.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function isOriginAllowed(
  url: string,
  allowedOrigins: BrowserAllowedOrigin[],
): BrowserOriginDecision {
  const normalized = normalizeOrigin(url);
  if (!normalized) {
    return { allowed: false, reason: 'invalid_url' };
  }

  let sawSchemeMismatch = false;
  let sawPortMismatch = false;

  for (const allowed of allowedOrigins) {
    if (!hostMatches(normalized.host, allowed)) {
      continue;
    }
    if (allowed.scheme !== normalized.scheme) {
      sawSchemeMismatch = true;
      continue;
    }

    const expectedPort = allowed.port ?? defaultPort(allowed.scheme);
    if (expectedPort !== normalized.port) {
      sawPortMismatch = true;
      continue;
    }

    return {
      allowed: true,
      origin: normalized.origin,
      matchedOrigin: allowed,
    };
  }

  if (sawSchemeMismatch) {
    return {
      allowed: false,
      origin: normalized.origin,
      reason: 'scheme_not_allowed',
    };
  }
  if (sawPortMismatch) {
    return {
      allowed: false,
      origin: normalized.origin,
      reason: 'port_not_allowed',
    };
  }
  return {
    allowed: false,
    origin: normalized.origin,
    reason: 'host_not_allowed',
  };
}
