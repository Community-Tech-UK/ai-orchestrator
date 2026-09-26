/**
 * MimoConsoleSessionRenewer
 *
 * Re-animates the MiMo console web session when the Token Plan quota API
 * starts answering 401/403. The platform's own 401 body carries a `loginUrl`
 * pointing at Xiaomi account SSO
 * (`account.xiaomi.com/pass/serviceLogin?callback=<signed /sts link>`); hitting
 * it with the persistent Xiaomi SSO cookies already stored in Chrome re-mints
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
 *    ever writing anything back into Chrome's cookie store.
 *  - Cookie values are never logged or persisted; the overlay lives in the
 *    probe's memory only.
 */

import { getLogger } from '../../../logging/logger';

const logger = getLogger('MimoConsoleSessionRenewer');

const MAX_REDIRECTS = 6;
const DEFAULT_TIMEOUT_MS = 15_000;
/** A renewal walk touches Xiaomi account SSO — at most once per half hour. */
const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000;

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

export interface MimoSessionRenewalResult {
  /** False when the walk was skipped (throttled) or refused (untrusted URL). */
  attempted: boolean;
  /** The redirect chain completed without a network error. */
  completed: boolean;
  /** Platform-domain session cookies seen along the way (name → value). */
  setCookies: Map<string, string>;
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
    const empty: MimoSessionRenewalResult = { attempted: false, completed: false, setCookies: new Map() };
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
    } catch (err) {
      logger.debug(`MiMo SSO cookie read failed: ${(err as Error).message}`);
    }

    const setCookies = new Map<string, string>();
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
        collectSetCookies(response.headers, url, setCookies);
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          const next = new URL(location, url).toString();
          if (!isAllowedHop(next)) {
            logger.warn('MiMo session renewal left the Xiaomi hosts — stopping the walk');
            return { attempted: true, completed: false, setCookies };
          }
          url = next;
          continue;
        }
        return { attempted: true, completed: true, setCookies };
      }
      logger.warn('MiMo session renewal exceeded its redirect budget');
      return { attempted: true, completed: false, setCookies };
    } catch (err) {
      logger.debug(`MiMo session renewal failed: ${(err as Error).message}`);
      return { attempted: true, completed: false, setCookies };
    }
  }
}

function collectSetCookies(
  headers: MimoRenewResponse['headers'],
  url: string,
  into: Map<string, string>,
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
    if (!isPlatformHost(url, domain)) continue;
    into.set(name, value);
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
