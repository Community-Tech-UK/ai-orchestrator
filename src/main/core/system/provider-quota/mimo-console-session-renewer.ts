/**
 * MimoConsoleSessionRenewer
 *
 * Re-animates the MiMo console web session when the Token Plan quota API
 * starts answering 401/403. The platform's own 401 body carries a `loginUrl`
 * pointing at Xiaomi account SSO
 * (`account.xiaomi.com/pass/serviceLogin?callback=<signed /sts link>`); hitting
 * it with Xiaomi SSO cookies from the selected usage login source re-mints
 * the console session without any credential entry (the account-host walk was
 * verified live 2026-09-25 — a walk of that chain restored quota access for
 * the same cookie values; the per-hop cookie scoping of platform hops is
 * covered by livetest Check 3).
 *
 * Behaviour:
 *  - Only follows `https` URLs on Xiaomi-owned hosts (open-redirect guard);
 *    the first URL must be `account.xiaomi.com`.
 *  - Follows at most {@link MAX_REDIRECTS} hops, never more.
 *  - Collects `Set-Cookie` values seen on `*.xiaomimimo.com` hops into the
 *    returned overlay so a rotated session can be used immediately — without
 *    ever writing anything back into Chrome's cookie store. The walk stops
 *    successfully as soon as the platform session is re-minted: the platform's
 *    own follow-up hop is plain `http://` and must never be fetched (no cookie
 *    travels over it).
 *  - Reports the rotated Xiaomi account SSO cookies (the "refresh" half of the
 *    login) so the caller can persist them with the rotated console session;
 *    only the exact pairs the encrypted store already allows are returned.
 *  - This renewer never logs cookie values. The caller may save rotated
 *    cookies to its encrypted usage session after quota access succeeds.
 */

import { getLogger } from '../../../logging/logger';
import { isPersistableMimoSsoCookie } from './mimo-saved-session-store';

const logger = getLogger('MimoConsoleSessionRenewer');

const MAX_REDIRECTS = 6;
const DEFAULT_TIMEOUT_MS = 15_000;
/** A renewal walk touches Xiaomi account SSO — at most once per half hour. */
const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000;
/**
 * The session cookies that make the quota API accept a request. Once the
 * platform has re-minted them the walk has succeeded; `userId` is carried over
 * from the stored session when the platform does not re-mint it.
 */
const MINTED_SESSION_COOKIES = ['api-platform_serviceToken', 'api-platform_slh', 'api-platform_ph'] as const;

export interface MimoRenewResponse {
  status: number;
  headers: {
    getSetCookie?: () => string[];
    get(name: string): string | null;
  };
}

export type MimoRenewFetch = (
  url: string,
  init: {
    method: 'GET';
    redirect: 'manual';
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<MimoRenewResponse>;

export interface MimoSessionRenewerOptions {
  fetchImpl?: MimoRenewFetch;
  now?: () => number;
  timeoutMs?: number;
  minIntervalMs?: number;
  userAgent?: string;
}

/**
 * A rotated Xiaomi account SSO cookie seen on a trusted walk, ready for the
 * caller's encrypted store. `domain` is the stored form (`account.xiaomi.com`
 * or `.xiaomi.com`); only pairs that store persists are ever produced.
 */
export interface MimoRenewedSsoCookie {
  domain: string;
  name: string;
  value: string;
}

export interface MimoSessionRenewalResult {
  /** False when the walk was skipped (throttled) or refused (untrusted URL). */
  attempted: boolean;
  /** The platform session was re-minted (or the chain ended normally). */
  completed: boolean;
  /** Platform-domain session cookies seen along the way (name → value). */
  setCookies: Map<string, string>;
  /** Rotated account SSO cookies for the caller to persist on success. */
  ssoCookies: MimoRenewedSsoCookie[];
}

/** True for the exact SSO entry point the platform's 401 body publishes. */
export function isTrustedLoginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname === 'account.xiaomi.com';
}

/** Redirect hops stay inside Xiaomi's account/platform hosts. */
function isAllowedHop(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  return host === 'account.xiaomi.com'
    || host.endsWith('.xiaomi.com')
    || host.endsWith('.xiaomimimo.com');
}

/** Account hosts receive the SSO cookies; platform hosts only the overlay. */
function isAccountHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.hostname === 'account.xiaomi.com' || parsed.hostname.endsWith('.xiaomi.com');
}

/** Hosts whose Set-Cookie values carry the platform session we need. */
function isPlatformHost(url: string, domainAttr: string | null): boolean {
  const host = (domainAttr ?? new URL(url).hostname).replace(/^\./, '');
  return host === 'xiaomimimo.com' || host.endsWith('.xiaomimimo.com');
}

/** Xiaomi account/platform hosts (https is checked separately). */
function isXiaomiHost(host: string): boolean {
  return host === 'account.xiaomi.com' || host.endsWith('.xiaomi.com') || host.endsWith('.xiaomimimo.com');
}

/** True once the platform has re-minted the session cookies the quota API needs. */
function hasMintedConsoleSession(setCookies: Map<string, string>): boolean {
  return MINTED_SESSION_COOKIES.every((name) => setCookies.has(name));
}

/**
 * Stored cookie domain, matching the usage-login capture: the account host
 * stays exact, everything else keeps its parent-domain dot.
 */
function savedSsoDomain(host: string): string {
  const bare = host.replace(/^\./, '');
  return bare === 'account.xiaomi.com' ? 'account.xiaomi.com' : `.${bare}`;
}

/**
 * RFC 6265 domain-match: the cookie's domain must be the response host or a
 * parent of it. A hop may not hand over a pair for a sibling host.
 */
function domainMatches(requestHost: string, cookieDomain: string): boolean {
  const host = requestHost.toLowerCase();
  const bare = cookieDomain.replace(/^\./, '').toLowerCase();
  return host === bare || host.endsWith(`.${bare}`);
}

/** Overlay cookies for a platform hop, as a Cookie header (values stay in memory). */
function overlayCookieHeader(setCookies: Map<string, string>): string {
  return [...setCookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

export type MimoSsoCookies = string | (() => Promise<string> | string);

export class MimoConsoleSessionRenewer {
  private readonly fetchImpl: MimoRenewFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly userAgent: string;
  private lastAttemptAt = 0;

  constructor(opts: MimoSessionRenewerOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.userAgent = opts.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  }

  async renew(
    loginUrl: string,
    ssoCookies: MimoSsoCookies,
    opts: { signal?: AbortSignal } = {},
  ): Promise<MimoSessionRenewalResult> {
    const empty: MimoSessionRenewalResult = { attempted: false, completed: false, setCookies: new Map(), ssoCookies: [] };
    if (!isTrustedLoginUrl(loginUrl)) {
      logger.warn('Refused an untrusted MiMo session renewal URL');
      return empty;
    }
    const now = this.now();
    if (this.lastAttemptAt > 0 && now - this.lastAttemptAt < this.minIntervalMs) {
      return empty;
    }
    this.lastAttemptAt = now;

    // Read the SSO cookies only once the walk is actually happening: skipped
    // walks (throttled, untrusted) must not pay a Keychain/cookie-DB read.
    let ssoCookieHeader = '';
    try {
      const supplied = typeof ssoCookies === 'function' ? await ssoCookies() : ssoCookies;
      ssoCookieHeader = supplied || '';
    } catch {
      logger.debug('MiMo SSO cookie read failed.');
    }

    const setCookies = new Map<string, string>();
    const renewedSsoCookies = new Map<string, MimoRenewedSsoCookie>();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal
      ? anySignal([opts.signal, deadline])
      : deadline;
    let url = loginUrl;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        // Browser-like scoping: account hosts get the account SSO cookies,
        // platform hosts get only the session cookies minted along the walk.
        const cookieHeader = isAccountHost(url)
          ? ssoCookieHeader
          : overlayCookieHeader(setCookies);
        const response = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'text/html,application/json',
            'User-Agent': this.userAgent,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          signal,
        });
        collectSetCookies(response.headers, url, setCookies, renewedSsoCookies);
        // The platform's own follow-up hop (the `followup` the 401's loginUrl
        // carries) is plain http. Stop as soon as the session is re-minted so
        // that hop is never fetched and no cookie can travel over it.
        if (hasMintedConsoleSession(setCookies)) {
          return { attempted: true, completed: true, setCookies, ssoCookies: [...renewedSsoCookies.values()] };
        }
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          const next = new URL(location, url);
          if (!isAllowedHop(next.toString())) {
            logger.warn(isXiaomiHost(next.hostname)
              ? 'MiMo session renewal stopped before a non-https hop'
              : 'MiMo session renewal left the Xiaomi hosts — stopping the walk');
            return { attempted: true, completed: false, setCookies, ssoCookies: [...renewedSsoCookies.values()] };
          }
          url = next.toString();
          continue;
        }
        return { attempted: true, completed: true, setCookies, ssoCookies: [...renewedSsoCookies.values()] };
      }
      logger.warn('MiMo session renewal exceeded its redirect budget');
      return { attempted: true, completed: false, setCookies, ssoCookies: [...renewedSsoCookies.values()] };
    } catch {
      logger.debug('MiMo session renewal failed.');
      return { attempted: true, completed: false, setCookies, ssoCookies: [...renewedSsoCookies.values()] };
    }
  }
}

function collectSetCookies(
  headers: MimoRenewResponse['headers'],
  url: string,
  into: Map<string, string>,
  ssoInto: Map<string, MimoRenewedSsoCookie>,
): void {
  const raw: string[] = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : splitCombinedSetCookie(headers.get('set-cookie'));
  for (const entry of raw) {
    const pair = entry.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) continue;
    const domain = /;\s*domain=([^;]+)/i.exec(entry)?.[1]?.trim() ?? null;
    if (isPlatformHost(url, domain)) {
      into.set(name, value);
      continue;
    }
    // Account-host rotations are the "refresh" half of the login. Only the
    // exact pairs the encrypted store persists are kept; anything else from
    // the walk (lookalike domains, non-SSO names) is dropped here.
    if (!isAccountHost(url)) continue;
    const requestHost = new URL(url).hostname;
    const cookieHost = (domain ?? requestHost).replace(/^\./, '');
    if (!domainMatches(requestHost, cookieHost)) continue;
    const savedDomain = savedSsoDomain(cookieHost);
    if (!isPersistableMimoSsoCookie(savedDomain, name)) continue;
    // A response may set the same pair twice; the later value is the one a
    // browser would keep, so it overwrites (first-seen order is preserved).
    ssoInto.set(`${savedDomain}|${name}`, { domain: savedDomain, name, value });
  }
}

function splitCombinedSetCookie(header: string | null): string[] {
  if (!header) return [];
  return header.split(/,(?=\s*[^;=]+=)/).map((entry) => entry.trim()).filter(Boolean);
}

const defaultFetch: MimoRenewFetch = async (url, init) => {
  const response = await fetch(url, init);
  // Not every Headers typing knows getSetCookie; probe for it structurally.
  const headers = response.headers as unknown as {
    getSetCookie?: () => string[];
    get(name: string): string | null;
  };
  return {
    status: response.status,
    headers: {
      getSetCookie: typeof headers.getSetCookie === 'function'
        ? () => headers.getSetCookie!()
        : undefined,
      get: (name: string) => response.headers.get(name),
    },
  };
};

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
