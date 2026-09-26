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
});
