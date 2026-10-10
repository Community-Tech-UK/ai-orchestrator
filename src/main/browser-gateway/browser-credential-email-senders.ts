import { getDomain } from 'tldts';
import type { BrowserEmailCodeReader } from './browser-email-code-reader';

/**
 * Email-code sender scoping and mailbox read for `fill_credential`'s
 * `email_code` fields. Split out of browser-form-fill-operations with the fill
 * targeting logic (browser-credential-fill-targeting) to keep the fill loop
 * readable.
 */

const DEFAULT_EMAIL_CODE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Validate agent-supplied sender domains against the origin that would RECEIVE
 * the one-time code's field (the fill's receiving frame origin, which for an
 * embedded cross-origin form differs from the tab's page origin): each
 * domain must equal the origin host, be a subdomain of it, or share the same
 * REGISTRABLE domain (public-suffix aware via tldts). This keeps email_code
 * disambiguation scoped to the site being filled — an agent can never point
 * the reader at an unrelated inbox sender (e.g. a bank) to harvest someone
 * else's code, and a public suffix like 'co.uk' or 'github.io' is never
 * accepted as "related" (its registrable domain is null). Hosts without a
 * registrable domain (localhost, IPs) fail closed to exact/subdomain matches.
 * Returns null when any domain fails; defaults to [originHost] when none are
 * supplied.
 */
export function resolveEmailSenderDomains(
  origin: string,
  requested: string[] | undefined,
  /**
   * Sender domains the live, human-granted authorization permits for this origin
   * even though they are unrelated to it (a shared notification platform such as
   * GOV.UK Notify). Explicit consent only — never derived from the page.
   */
  authorized?: string[],
): string[] | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const authorizedNormalized = (authorized ?? [])
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
  if (!requested || requested.length === 0) {
    // De-duplicate: an authorization may name the origin host itself.
    return [...new Set([host, ...authorizedNormalized])];
  }
  // allowPrivateDomains: platform suffixes (github.io, netlify.app, …) are
  // boundaries too — two tenants of one platform are unrelated parties.
  const PSL_OPTIONS = { allowPrivateDomains: true };
  const registrable = getDomain(host, PSL_OPTIONS);
  const related = (domain: string): boolean => {
    if (domain === host || domain.endsWith(`.${host}`)) {
      return true;
    }
    if (authorizedNormalized.includes(domain)) {
      return true;
    }
    return registrable !== null && getDomain(domain, PSL_OPTIONS) === registrable;
  };
  const normalized = requested.map((domain) => domain.trim().toLowerCase());
  return normalized.every((domain) => domain.length > 0 && related(domain))
    ? normalized
    : null;
}

export async function resolveEmailCode(
  reader: Pick<BrowserEmailCodeReader, 'fetchCode'>,
  senderDomains: string[],
  options: { sinceMs?: number; withinMs?: number } | undefined,
): Promise<string> {
  const withinMs = options?.withinMs ?? DEFAULT_EMAIL_CODE_WINDOW_MS;
  const result = await reader.fetchCode({
    expectedSenderDomains: senderDomains,
    sinceMs: options?.sinceMs ?? Date.now() - withinMs,
    withinMs,
  });
  return result.code;
}
