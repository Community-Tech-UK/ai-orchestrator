import { parse as parseHost } from 'tldts';

/**
 * Origin validation for credential bindings and authorizations.
 *
 * Lives main-side, and is applied by BOTH doors (the renderer IPC handlers and
 * the `aio-mcp browser-credentials` CLI), because as of 2026-08-29 the CLI is
 * agent-callable. Validating only in the CLI process would make this advisory:
 * anything that can reach the RPC socket could skip it.
 *
 * Two failure directions matter here and they are not symmetric:
 *
 *   - Too NARROW mints a grant that can never match at fill time. It fails
 *     safe, but for a feature whose whole point is unattended operation it is a
 *     defect: the command reports success and the problem surfaces hours later
 *     as `origin_not_authorized`. `browser-credential-vault.ts` normalises a
 *     binding with `new URL(origin).host`, so anything this accepts must agree
 *     with that or the two can never meet.
 *   - Too WIDE is a capability. `*.com` is a login grant over most of the web.
 *
 * Two ordering rules earn their keep, both learned from getting them wrong:
 *
 *   1. Shape checks run AFTER Unicode normalisation, never before. IDNA/UTS-46
 *      mapping can CREATE the characters the checks look for: `＊.com`
 *      (U+FF0A) becomes `*.com`, and `example。。com` (U+3002) becomes
 *      `example..com`. Checking the raw string first and trusting it is how a
 *      registry-wide wildcard gets past a guard written to stop exactly that.
 *   2. Recoverable differences are NORMALISED, not rejected. Mixed case and a
 *      `*.` typed into a host field are both things the fill-time matcher has
 *      always handled, so rejecting them would break inputs that work today.
 *      Only genuinely unsafe or unmatchable origins throw.
 */

export interface CredentialAuthorizationOriginInput {
  scheme: 'https' | 'http';
  hostPattern: string;
  includeSubdomains: boolean;
}

export class CredentialOriginError extends Error {}

function fail(raw: string, why: string): never {
  throw new CredentialOriginError(`Invalid origin '${raw}': ${why}`);
}

/** Strip a leading ASCII `*.`, reporting whether one was there. */
function splitWildcard(host: string): { host: string; wildcard: boolean } {
  return host.startsWith('*.')
    ? { host: host.slice(2), wildcard: true }
    : { host, wildcard: false };
}

/**
 * Refuse a wildcard whose base is a public suffix.
 *
 * `allowPrivateDomains` is on deliberately. Without it `*.pages.dev`,
 * `*.github.io` and `*.vercel.app` all pass, and each is a credential-fill
 * grant over every tenant of a multi-tenant host, including one an attacker can
 * register in minutes. That is the same shape of mistake as `*.com`, just less
 * obvious.
 */
function assertWildcardIsNotAPublicSuffix(raw: string, host: string): void {
  const parsed = parseHost(host, { allowPrivateDomains: true });
  if (parsed.isIp) {
    fail(raw, 'a wildcard cannot be used with an IP address');
  }
  if (parsed.publicSuffix !== null && parsed.publicSuffix === host) {
    fail(
      raw,
      `'${host}' is a public suffix, so '*.${host}' would grant every site under it. `
        + 'Name the organisation domain instead.',
    );
  }
  if (parsed.domain === null) {
    fail(raw, `'${host}' is not a registrable domain, so a wildcard cannot be scoped to it`);
  }
}

/**
 * `https://portal.example.gov.uk`, `https://*.example.gov.uk`, or a pasted
 * address-bar URL (the path is dropped, as the vault's own binding
 * normalisation already does).
 */
export function parseCredentialOrigin(raw: string): CredentialAuthorizationOriginInput {
  const trimmed = raw.trim();
  const shape = /^(https?):\/\/([^/?#\s]+)(?:[/?#].*)?$/i.exec(trimmed);
  if (!shape) {
    fail(raw, 'expected https://host or https://*.host');
  }
  const scheme = shape![1]!.toLowerCase() as 'https' | 'http';

  // Take the wildcard off before URL parsing, because `*.` is not a legal URL
  // host and would be percent-encoded.
  const beforeUrl = splitWildcard(shape![2]!);

  let url: URL;
  try {
    // Parse under the ACTUAL scheme. Reconstructing with a hardcoded `https://`
    // applies WHATWG default-port stripping for the wrong scheme, which
    // silently rebinds `http://host:443` to `http://host`.
    url = new URL(`${scheme}://${beforeUrl.host}`);
  } catch {
    return fail(raw, 'not a valid host');
  }
  if (url.username !== '' || url.password !== '') {
    fail(raw, 'must not contain credentials (user@host)');
  }

  // Everything below inspects the NORMALISED host. See ordering rule 1.
  const afterUrl = splitWildcard(url.hostname.toLowerCase());
  if (beforeUrl.wildcard && afterUrl.wildcard) {
    // Stripping in two places (once before URL parsing for the ASCII form, once
    // after for a form IDNA mapping created) let `*.*.host` past the `*` guard
    // below, because each strip removed one.
    fail(raw, "a wildcard is only allowed as a leading '*.'");
  }
  const includeSubdomains = beforeUrl.wildcard || afterUrl.wildcard;
  let hostname = afterUrl.host;

  if (hostname.includes('*')) {
    fail(raw, "a wildcard is only allowed as a leading '*.'");
  }
  if (hostname.includes('@')) {
    fail(raw, 'must not contain credentials (user@host)');
  }
  // One trailing dot is the legal absolute-root form and the browser drops it.
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }
  if (hostname === '' || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) {
    fail(raw, 'host has an empty label');
  }
  if (includeSubdomains) {
    assertWildcardIsNotAPublicSuffix(raw, hostname);
  }

  // Keep a non-default port. `originMatches` compares hostPattern against
  // `new URL(pageUrl).host`, which INCLUDES a non-default port, so a ported
  // origin authorizes correctly and always has. An earlier version of this
  // module refused ports on the false premise that they could never be
  // authorized, which removed a working capability (a council portal on :8443
  // had no route at all). `url.port` is empty for the scheme's default port,
  // matching what the page side produces.
  if (url.port === '0') {
    fail(raw, 'port 0 is not reachable, so the grant could never match');
  }
  const hostPattern = url.port === '' ? hostname : `${hostname}:${url.port}`;
  return { scheme, hostPattern, includeSubdomains };
}

/**
 * Enrolment binds a login to one concrete origin, so a wildcard is meaningless
 * here. Returns the normalised `scheme://host` the vault should store.
 */
export function normaliseBindableOrigin(raw: string): string {
  const parsed = parseCredentialOrigin(raw);
  if (parsed.includeSubdomains) {
    fail(raw, 'a wildcard cannot be enrolled; bind the exact origin you log in to');
  }
  return `${parsed.scheme}://${parsed.hostPattern}`;
}

/**
 * Main-side guard for an already-structured origin arriving over RPC or IPC.
 *
 * Returns the origin to STORE. Recoverable differences (case, a `*.` typed into
 * the host field) are normalised rather than refused, so a form the panel has
 * always accepted keeps working; genuinely unsafe or unmatchable origins throw.
 */
export function normaliseAuthorizationOrigin(
  origin: CredentialAuthorizationOriginInput,
): CredentialAuthorizationOriginInput {
  if (/[/\\]/.test(origin.hostPattern)) {
    // A pasted URL in a host field would otherwise render as
    // `https://https://host`, parse as scheme + path, and silently store the
    // hostPattern `https`, which matches nothing the caller meant.
    fail(
      origin.hostPattern,
      'the host field takes a host, not a URL; remove the scheme and path',
    );
  }
  // Take the wildcard off the host before re-rendering it. Prefixing `*.` onto
  // a hostPattern that already carries one produces `*.*.host`, which the
  // doubled-wildcard guard correctly refuses, so a legitimate grant would be
  // rejected by a check meant for a hostile input.
  const bare = origin.hostPattern.startsWith('*.')
    ? origin.hostPattern.slice(2)
    : origin.hostPattern;
  const wildcard = origin.includeSubdomains || origin.hostPattern.startsWith('*.');
  const rendered = `${origin.scheme}://${wildcard ? '*.' : ''}${bare}`;
  const parsed = parseCredentialOrigin(rendered);
  return {
    scheme: parsed.scheme,
    hostPattern: parsed.hostPattern,
    // A leading `*.` in the host field has always meant "and subdomains" to the
    // fill-time matcher, so honour it rather than silently narrowing the grant.
    includeSubdomains: parsed.includeSubdomains || origin.includeSubdomains,
  };
}
