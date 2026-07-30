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

/**
 * True when `candidate` authorizes every URL `requested` would.
 *
 * Pattern-vs-pattern, unlike isOriginAllowed which matches one concrete URL.
 * Used to answer "does a live grant already cover this grant proposal?" so a
 * re-request cannot raise a second approval dialog for permission the user has
 * already given.
 */
export function allowedOriginCovers(
  candidate: BrowserAllowedOrigin,
  requested: BrowserAllowedOrigin,
): boolean {
  if (candidate.scheme !== requested.scheme) {
    return false;
  }
  const candidatePort = candidate.port ?? defaultPort(candidate.scheme);
  const requestedPort = requested.port ?? defaultPort(requested.scheme);
  if (candidatePort !== requestedPort) {
    return false;
  }
  const candidateHost = normalizeHostPattern(candidate.hostPattern);
  const requestedHost = normalizeHostPattern(requested.hostPattern);
  if (candidateHost === requestedHost) {
    // A host-only candidate cannot stand in for a subdomain-wide request.
    return candidate.includeSubdomains || !requested.includeSubdomains;
  }
  return candidate.includeSubdomains && requestedHost.endsWith(`.${candidateHost}`);
}

export function allowedOriginsCover(
  candidates: BrowserAllowedOrigin[],
  requested: BrowserAllowedOrigin[],
): boolean {
  return (
    requested.length > 0 &&
    requested.every((origin) =>
      candidates.some((candidate) => allowedOriginCovers(candidate, origin)),
    )
  );
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
