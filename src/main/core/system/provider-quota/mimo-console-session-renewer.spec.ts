import { describe, it, expect, vi } from 'vitest';
import {
  MimoConsoleSessionRenewer,
  isTrustedLoginUrl,
  type MimoRenewFetch,
  type MimoRenewResponse,
} from './mimo-console-session-renewer';

function response(
  status: number,
  opts: { location?: string; setCookies?: string[] } = {},
): MimoRenewResponse {
  const headers = new Map<string, string>();
  if (opts.location) headers.set('location', opts.location);
  return {
    status,
    headers: {
      getSetCookie: () => opts.setCookies ?? [],
      get: (name: string) => headers.get(name.toLowerCase()) ?? headers.get(name) ?? null,
    },
  };
}

function scriptFetch(script: MimoRenewResponse[]): { fetch: MimoRenewFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: MimoRenewFetch = async (url) => {
    calls.push(url);
    const next = script.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next;
  };
  return { fetch, calls };
}

const SSO = 'cUserId=abc; passToken=def';

describe('isTrustedLoginUrl', () => {
  it('accepts the platform-published Xiaomi SSO entry point', () => {
    expect(isTrustedLoginUrl('https://account.xiaomi.com/pass/serviceLogin?callback=x')).toBe(true);
  });

  it('refuses other hosts, plain http, and garbage', () => {
    expect(isTrustedLoginUrl('https://evil.example/pass/serviceLogin')).toBe(false);
    expect(isTrustedLoginUrl('http://account.xiaomi.com/pass/serviceLogin')).toBe(false);
    expect(isTrustedLoginUrl('https://account.xiaomi.com.evil.example/x')).toBe(false);
    expect(isTrustedLoginUrl('not a url')).toBe(false);
  });
});

describe('MimoConsoleSessionRenewer', () => {
  it('completes the walk and captures platform Set-Cookies', async () => {
    const { fetch, calls } = scriptFetch([
      response(302, {
        location: 'https://platform.xiaomimimo.com/sts?sign=abc&followup=/console',
        setCookies: ['serviceToken=account-one; Domain=.account.xiaomi.com'],
      }),
      response(302, {
        location: 'https://platform.xiaomimimo.com/console/plan-manage',
        setCookies: [
          'api-platform_serviceToken=fresh; Domain=.platform.xiaomimimo.com; HttpOnly',
          'api-platform_slh=fresh-slh; Domain=.platform.xiaomimimo.com',
        ],
      }),
      response(200),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew(
      'https://account.xiaomi.com/pass/serviceLogin?callback=platform',
      SSO,
      { signal: new AbortController().signal },
    );

    expect(result.attempted).toBe(true);
    expect(result.completed).toBe(true);
    // Only platform cookies are captured; the account-domain one is not the
    // console session and must not leak into the quota request.
    expect([...result.setCookies]).toEqual([
      ['api-platform_serviceToken', 'fresh'],
      ['api-platform_slh', 'fresh-slh'],
    ]);
    expect(calls[0]).toContain('account.xiaomi.com');
  });

  it('refuses an untrusted login URL without fetching', async () => {
    const { fetch, calls } = scriptFetch([]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://evil.example/steal', SSO);

    expect(result.attempted).toBe(false);
    expect(result.completed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('stops with completed=false when the chain leaves the Xiaomi hosts', async () => {
    const { fetch, calls } = scriptFetch([
      response(302, { location: 'https://evil.example/next' }),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    expect(result.completed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('throttles repeated renewal attempts', async () => {
    let now = 1_000_000;
    const { fetch } = scriptFetch([
      response(200),
      response(200),
    ]);
    const renewer = new MimoConsoleSessionRenewer({
      fetchImpl: fetch,
      now: () => now,
      minIntervalMs: 30 * 60_000,
    });

    const first = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);
    const second = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);
    expect(first.attempted).toBe(true);
    expect(second.attempted).toBe(false);

    now += 31 * 60_000;
    const third = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);
    expect(third.attempted).toBe(true);
  });

  it('reports completed=false when the walk throws', async () => {
    const fetch: MimoRenewFetch = async () => {
      throw new Error('network down');
    };
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    expect(result.attempted).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.setCookies.size).toBe(0);
  });

  it('sends the SSO cookies to account hosts only, overlay cookies to platform hosts', async () => {
    const seen: Array<{ url: string; cookie?: string }> = [];
    const script: MimoRenewResponse[] = [
      response(302, {
        location: 'https://platform.xiaomimimo.com/sts?sign=abc',
        setCookies: ['api-platform_serviceToken=fresh; Domain=.platform.xiaomimimo.com'],
      }),
      response(200),
    ];
    const fetch: MimoRenewFetch = async (url, init) => {
      seen.push({ url, cookie: init.headers['Cookie'] });
      const next = script.shift();
      if (!next) throw new Error('unexpected extra fetch');
      return next;
    };
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    // Account hop carries the SSO cookies; the platform hop carries only the
    // session cookie minted along the walk — never the account SSO values.
    expect(seen[0].url).toContain('account.xiaomi.com');
    expect(seen[0].cookie).toBe(SSO);
    expect(seen[1].url).toContain('platform.xiaomimimo.com');
    expect(seen[1].cookie).toBe('api-platform_serviceToken=fresh');
  });

  it('does not read SSO cookies when the walk is skipped', async () => {
    const reads = vi.fn(async () => SSO);
    const { fetch } = scriptFetch([response(200), response(200)]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch, minIntervalMs: 30 * 60_000 });

    const refused = await renewer.renew('https://evil.example/steal', reads);
    expect(refused.attempted).toBe(false);
    expect(reads).not.toHaveBeenCalled();

    await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', reads);
    expect(reads).toHaveBeenCalledTimes(1);

    const throttled = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', reads);
    expect(throttled.attempted).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('excludes lookalike domains from the Set-Cookie overlay', async () => {
    const { fetch } = scriptFetch([
      response(302, {
        location: 'https://platform.xiaomimimo.com/sts',
        setCookies: [
          'api-platform_serviceToken=good; Domain=.platform.xiaomimimo.com',
          'api-platform_slh=evil; Domain=evilxiaomimimo.com',
        ],
      }),
      response(200),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    expect([...result.setCookies]).toEqual([['api-platform_serviceToken', 'good']]);
  });

  it('tolerates a throwing SSO cookie supplier', async () => {
    const { fetch } = scriptFetch([response(200)]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', async () => {
      throw new Error('keychain denied');
    });

    // Best-effort: the walk still runs (unauthenticated it just cannot renew).
    expect(result.attempted).toBe(true);
    expect(result.completed).toBe(true);
  });

  it('completes the live platform chain whose follow-up hop is plain http', async () => {
    // Replay of the real chain (2026-10-14): the platform's 401 publishes
    // serviceLogin?callback=<https platform /sts…followup=http://platform…>;
    // the /sts hop mints the console session and redirects to that http
    // follow-up. The minted session must win — the walk may stop before the
    // plain-http hop, but it must not report failure and throw the cookies away.
    const { fetch, calls } = scriptFetch([
      response(302, {
        location: 'https://platform.xiaomimimo.com/sts?sign=abc&followup=http%3A%2F%2Fplatform.xiaomimimo.com%2Fapi%2Fv1%2FtokenPlan%2Fusage',
        setCookies: ['passToken=PLACEHOLDER_ROTATED; Domain=account.xiaomi.com'],
      }),
      response(302, {
        location: 'http://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
        setCookies: [
          'api-platform_serviceToken=fresh; Domain=.platform.xiaomimimo.com',
          'api-platform_slh=fresh-slh; Domain=.platform.xiaomimimo.com',
          'api-platform_ph=fresh-ph; Domain=.platform.xiaomimimo.com',
          'userId=PLACEHOLDER_USER; Domain=.xiaomimimo.com',
        ],
      }),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew(
      'https://account.xiaomi.com/pass/serviceLogin?callback=platform',
      SSO,
      { signal: new AbortController().signal },
    );

    expect(result.completed).toBe(true);
    expect(Object.fromEntries(result.setCookies)).toEqual({
      'api-platform_serviceToken': 'fresh',
      'api-platform_slh': 'fresh-slh',
      'api-platform_ph': 'fresh-ph',
      userId: 'PLACEHOLDER_USER',
    });
    // No cookie is ever sent to the plain-http follow-up: it is not fetched.
    expect(calls.some((url) => url.startsWith('http://'))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('completes when only the session trio is re-minted and userId stays in the stored session', async () => {
    const { fetch } = scriptFetch([
      response(302, { location: 'https://platform.xiaomimimo.com/sts?sign=abc' }),
      response(302, {
        location: 'http://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
        setCookies: [
          'api-platform_serviceToken=fresh; Domain=.platform.xiaomimimo.com',
          'api-platform_slh=fresh-slh; Domain=.platform.xiaomimimo.com',
          'api-platform_ph=fresh-ph; Domain=.platform.xiaomimimo.com',
        ],
      }),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    expect(result.completed).toBe(true);
    expect([...result.setCookies.keys()].sort()).toEqual([
      'api-platform_ph', 'api-platform_serviceToken', 'api-platform_slh',
    ]);
  });

  it('returns rotated account SSO cookies for the caller to persist', async () => {
    const { fetch } = scriptFetch([
      response(302, {
        location: 'https://platform.xiaomimimo.com/sts?sign=abc',
        setCookies: [
          'passToken=PLACEHOLDER_ROTATED; Domain=account.xiaomi.com',
          'cUserId=PLACEHOLDER_PARENT_ROTATED; Domain=.xiaomi.com',
          'userId=PLACEHOLDER_NOT_PERSISTED; Domain=.xiaomi.com',
          'serviceToken=PLACEHOLDER_NOT_SSO; Domain=account.xiaomi.com',
          'passToken=PLACEHOLDER_LOOKALIKE; Domain=account.xiaomi.com.evil.example',
        ],
      }),
      response(200),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    // Only the exact SSO pairs the encrypted store persists, from real Xiaomi
    // account hosts. Lookalike domains and non-SSO names never reach the store.
    expect(result.ssoCookies).toEqual([
      { domain: 'account.xiaomi.com', name: 'passToken', value: 'PLACEHOLDER_ROTATED' },
      { domain: '.xiaomi.com', name: 'cUserId', value: 'PLACEHOLDER_PARENT_ROTATED' },
    ]);
    expect([...result.setCookies]).toEqual([]);
  });

  it('keeps stopping at genuinely foreign hosts without minted session cookies', async () => {
    const { fetch } = scriptFetch([
      response(302, {
        location: 'https://evil.example/next',
        setCookies: ['passToken=PLACEHOLDER_ROTATED; Domain=account.xiaomi.com'],
      }),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    expect(result.completed).toBe(false);
  });

  it('drops an SSO cookie whose Domain does not domain-match the response host', async () => {
    // A hop on a sibling Xiaomi host must not hand over a pair for
    // account.xiaomi.com — a browser would reject that Set-Cookie outright.
    const { fetch } = scriptFetch([
      response(302, { location: 'https://foo.xiaomi.com/next' }),
      response(302, {
        location: 'https://platform.xiaomimimo.com/sts',
        setCookies: ['passToken=PLACEHOLDER_SIBLING; Domain=account.xiaomi.com'],
      }),
      response(200),
    ]);
    const renewer = new MimoConsoleSessionRenewer({ fetchImpl: fetch });

    const result = await renewer.renew('https://account.xiaomi.com/pass/serviceLogin', SSO);

    expect(result.ssoCookies).toEqual([]);
  });
});
