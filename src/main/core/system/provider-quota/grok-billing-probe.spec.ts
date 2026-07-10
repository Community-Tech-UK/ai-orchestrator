import { describe, it, expect } from 'vitest';
import {
  GrokBillingProbe,
  parseGrokBillingPayload,
  type GrokAuthFileReader,
  type GrokBillingFetch,
} from './grok-billing-probe';

const AUTH_JSON = JSON.stringify({
  'https://auth.x.ai::client': {
    key: 'grok-bearer-token',
    expires_at: '2099-01-01T00:00:00Z',
    refresh_token: 'do-not-touch',
  },
});

function reader(content: string | null): GrokAuthFileReader {
  return async () => {
    if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

describe('GrokBillingProbe', () => {
  it('reads Grok auth read-only, fetches billing, and returns percentage windows', async () => {
    const calls: string[] = [];
    const fetchBilling: GrokBillingFetch = async (token) => {
      calls.push(token);
      return {
        status: 200,
        body: {
          config: {
            monthlyLimit: { val: 20 },
            used: { val: 5 },
            onDemandCap: { val: 100 },
            billingPeriodEnd: '2026-08-01T00:00:00Z',
            history: [{ onDemandUsed: { val: 10 } }],
          },
        },
      };
    };

    const probe = new GrokBillingProbe({
      readFile: reader(AUTH_JSON),
      fetchBilling,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(calls).toEqual(['grok-bearer-token']);
    expect(snap).toMatchObject({ provider: 'grok', ok: true, source: 'admin-api' });
    expect(snap!.windows).toEqual([
      expect.objectContaining({
        id: 'grok.monthly',
        label: 'Monthly',
        used: 25,
        limit: 100,
        remaining: 75,
        resetsAt: Date.parse('2026-08-01T00:00:00Z'),
      }),
      expect.objectContaining({
        id: 'grok.on-demand',
        label: 'On-demand',
        used: 10,
        limit: 100,
        remaining: 90,
      }),
    ]);
  });

  it('parses zero monthlyLimit as 0% (not 100%)', () => {
    const windows = parseGrokBillingPayload({
      config: {
        monthlyLimit: { val: 0 },
        used: { val: 0 },
        onDemandCap: { val: 0 },
        billingPeriodEnd: '2026-08-01T00:00:00Z',
      },
    });
    expect(windows).toEqual([
      expect.objectContaining({ id: 'grok.monthly', used: 0, limit: 100 }),
    ]);
  });

  it('returns ok=false when auth.json is absent instead of mutating refresh tokens', async () => {
    const probe = new GrokBillingProbe({ readFile: reader(null) });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/not signed in|auth\.json/i);
  });

  it('does NOT flag reauth when the access token is expired but a refresh_token exists', async () => {
    // The Grok CLI silently refreshes the short-lived access token via the
    // stored refresh_token, so an expired `key` alongside a valid refresh_token
    // must NOT surface the "Reauth needed" affordance (it would fire every ~5h).
    const expired = JSON.stringify({
      'https://auth.x.ai::client': {
        key: 'stale-token',
        expires_at: '2020-01-01T00:00:00Z',
        refresh_token: 'do-not-touch',
      },
    });
    let fetched = false;
    const probe = new GrokBillingProbe({
      readFile: reader(expired),
      fetchBilling: async () => {
        fetched = true;
        return { status: 200, body: {} };
      },
      now: () => Date.parse('2026-07-09T12:00:00Z'),
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBeFalsy();
    expect(snap!.error).toMatch(/refreshes it automatically/i);
    // Read-only discipline: never call billing with the stale token.
    expect(fetched).toBe(false);
  });

  it('flags reauth when the OIDC key is expired and no refresh_token is present', async () => {
    const expired = JSON.stringify({
      'https://auth.x.ai::client': {
        key: 'stale-token',
        expires_at: '2020-01-01T00:00:00Z',
      },
    });
    const probe = new GrokBillingProbe({
      readFile: reader(expired),
      now: () => Date.parse('2026-07-09T12:00:00Z'),
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/expired/i);
  });

  it('treats 401 as needsReauth', async () => {
    const probe = new GrokBillingProbe({
      readFile: reader(AUTH_JSON),
      fetchBilling: async () => ({ status: 401, body: null }),
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
  });
});
