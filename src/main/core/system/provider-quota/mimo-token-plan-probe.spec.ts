import { describe, it, expect, vi } from 'vitest';
import {
  MimoTokenPlanProbe,
  isTokenPlanModelSetting,
  parseMimoTokenPlanResponses,
  type MimoTokenPlanFetch,
} from './mimo-token-plan-probe';
import type { MimoCredentialResult, MimoConsoleSession } from './mimo-console-credentials-reader';

const SESSION: MimoConsoleSession = {
  cookieHeader: 'api-platform_serviceToken=placeholder; api-platform_slh=placeholder; api-platform_ph=placeholder; userId=test-user-id',
  userId: 'test-user-id',
};

// Recorded console shapes with obviously placeholder figures (2026-09-23).
const USAGE_BODY = {
  code: 0,
  message: '',
  data: {
    monthUsage: {
      percent: 0.0025,
      items: [{ name: 'month_total_token', used: 2500000, limit: 100000000, percent: 0.0025 }],
    },
    usage: {
      percent: 0.01,
      items: [
        { name: 'plan_total_token', used: 2500000, limit: 100000000, percent: 0.01 },
        { name: 'compensation_total_token', used: 0, limit: 0, percent: 0 },
      ],
    },
  },
};

const DETAIL_BODY = {
  code: 0,
  message: '',
  data: {
    planCode: 'pro',
    planName: 'Pro',
    currentPeriodEnd: '2030-01-15 23:59:59',
    expired: false,
    enableAutoRenew: true,
    hasAutoRenewSubscribed: true,
    clawEnabled: false,
    clawPurchased: false,
    clawPeriodEnd: null,
    autoRenewDiscount: null,
  },
};

function usageBody(usageItems: unknown[], monthItems: unknown[] = []): unknown {
  return {
    code: 0,
    data: {
      monthUsage: { percent: 0, items: monthItems },
      usage: { percent: 0, items: usageItems },
    },
  };
}

function okFetch(overrides?: { usage?: unknown; detail?: unknown }): MimoTokenPlanFetch {
  return async () => ({
    usage: { status: 200, body: overrides?.usage ?? USAGE_BODY },
    detail: { status: 200, body: overrides?.detail ?? DETAIL_BODY },
  });
}

function readerReturning(result: MimoCredentialResult) {
  const state = { calls: 0 };
  return {
    state,
    reader: {
      read: async () => {
        state.calls += 1;
        return result;
      },
    },
  };
}

describe('isTokenPlanModelSetting', () => {
  it('accepts a xiaomi-token-plan-* model from the per-provider setting', () => {
    expect(isTokenPlanModelSetting({
      defaultModelByProvider: { opencode: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
    })).toBe(true);
  });

  it('falls back to the legacy global defaultModel', () => {
    expect(isTokenPlanModelSetting({
      defaultModel: 'xiaomi-token-plan-sgp/mimo-v2.6-flash',
    })).toBe(true);
  });

  it('rejects other OpenCode backends and empty/absent settings', () => {
    expect(isTokenPlanModelSetting({
      defaultModelByProvider: { opencode: 'opencode/mimo-v2.6-flash-free' },
      defaultModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
    })).toBe(false);
    expect(isTokenPlanModelSetting({ defaultModel: 'opus[1m]' })).toBe(false);
    expect(isTokenPlanModelSetting({})).toBe(false);
    expect(isTokenPlanModelSetting(null)).toBe(false);
  });
});

describe('parseMimoTokenPlanResponses', () => {
  it('derives token windows from used/limit and parses the period end as UTC', () => {
    const { windows, plan } = parseMimoTokenPlanResponses(USAGE_BODY, DETAIL_BODY);

    expect(plan).toBe('Pro');
    expect(windows.map((w) => w.id)).toEqual(['opencode.plan', 'opencode.monthly']);
    expect(windows[0]).toMatchObject({
      kind: 'calendar-period',
      label: 'Plan',
      unit: 'tokens',
      used: 2500000,
      limit: 100000000,
      remaining: 97500000,
      overage: false,
    });
    // Naive console timestamps are UTC (the console parses them with
    // dayjs.utc) — a local-time parse would drift "resets" by the offset.
    expect(windows[0].resetsAt).toBe(Date.parse('2030-01-15T23:59:59Z'));
  });

  it('ignores the payload percent fields (fractions, inconsistently rounded)', () => {
    const body = usageBody(
      [{ name: 'plan_total_token', used: 2500000, limit: 100000000, percent: 0.99 }],
    );
    const { windows } = parseMimoTokenPlanResponses(body, DETAIL_BODY);
    expect(windows[0].used).toBe(2500000);
    expect(windows[0].limit).toBe(100000000);
  });

  it('skips an unmetered bucket (compensation 0/0)', () => {
    const { windows } = parseMimoTokenPlanResponses(USAGE_BODY, DETAIL_BODY);
    expect(windows.map((w) => w.label)).not.toContain('Compensation');
  });

  it('includes a metered compensation bucket as granted credit, not overage', () => {
    const body = usageBody([
      { name: 'plan_total_token', used: 2500000, limit: 100000000 },
      { name: 'compensation_total_token', used: 5, limit: 10 },
    ]);
    const { windows } = parseMimoTokenPlanResponses(body, DETAIL_BODY);
    const compensation = windows.find((w) => w.label === 'Compensation');
    expect(compensation).toMatchObject({ used: 5, limit: 10, overage: false });
  });

  it('surfaces unknown bucket names instead of dropping them', () => {
    const body = usageBody([{ name: 'bonus_token_pool', used: 1, limit: 4 }]);
    const { windows } = parseMimoTokenPlanResponses(body, DETAIL_BODY);
    expect(windows.map((w) => w.label)).toContain('bonus token pool');
  });

  it('drops unreadable buckets rather than inventing a 0%', () => {
    const body = usageBody([{ name: 'plan_total_token', used: 'lots', limit: 'many' }]);
    const { windows } = parseMimoTokenPlanResponses(body, DETAIL_BODY);
    expect(windows).toEqual([]);
  });

  it('returns no windows on a changed response shape', () => {
    expect(parseMimoTokenPlanResponses({ data: {} }, DETAIL_BODY).windows).toEqual([]);
    expect(parseMimoTokenPlanResponses(null, null).windows).toEqual([]);
  });
});

describe('MimoTokenPlanProbe', () => {
  it('reports the Token Plan allowance for the opencode provider', async () => {
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: SESSION }).reader,
      fetchPlans: okFetch(),
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap).toMatchObject({ provider: 'opencode', ok: true, source: 'admin-api', plan: 'Pro' });
    expect(snap!.windows[0].id).toBe('opencode.plan');
  });

  it('returns an explicit notApplicable snapshot (not null) when the configured model is not a Token Plan one (LT-650)', async () => {
    // A plain `null` here would mean "no fresh info, keep the previous
    // snapshot" under ProviderQuotaService's general probe contract — which
    // is exactly the LT-650 bug (stale Token Plan numbers survive a model
    // switch). `notApplicable: true` instead tells the service to replace
    // whatever was stored, with zero credential reads on this path.
    const { reader, state } = readerReturning({ session: SESSION });
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => false,
      reader,
      fetchPlans: okFetch(),
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap).not.toBeNull();
    expect(snap).toMatchObject({ provider: 'opencode', ok: false, notApplicable: true, windows: [] });
    expect(state.calls).toBe(0);
  });

  it('flags reauth with the console fix when no session can be read', async () => {
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: null, reason: 'not-found' }).reader,
      fetchPlans: okFetch(),
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/MiMo console in Chrome/i);
  });

  it('names the Keychain fix (without a sign-in nudge) when the read is guarded', async () => {
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: null, reason: 'denied' }).reader,
      fetchPlans: okFetch(),
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBeFalsy();
    expect(snap!.error).toMatch(/Keychain/i);
  });

  it('treats a 401 console session as needsReauth', async () => {
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: SESSION }).reader,
      fetchPlans: async () => ({
        usage: { status: 401, body: { code: 401 } },
        detail: { status: 401, body: { code: 401 } },
      }),
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/401/);
  });

  it('renews the console session through the platform SSO URL and re-pulls the quota', async () => {
    const renewCalls: Array<{ url: string; sso: string }> = [];
    const fetchSessions: MimoConsoleSession[] = [];
    let first = true;
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: {
        read: async () => ({ session: SESSION }),
        readAccountSso: async () => ({ cookieHeader: 'cUserId=abc; passToken=def' }),
      },
      fetchPlans: async (session) => {
        fetchSessions.push(session);
        if (first) {
          first = false;
          return {
            usage: { status: 401, body: { code: 401, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin?callback=platform' } },
            detail: { status: 401, body: { code: 401 } },
          };
        }
        return { usage: { status: 200, body: USAGE_BODY }, detail: { status: 200, body: DETAIL_BODY } };
      },
      renewer: {
        renew: async (url, sso) => {
          renewCalls.push({ url, sso: await (typeof sso === 'function' ? sso() : sso) });
          return {
            attempted: true,
            completed: true,
            setCookies: new Map([['api-platform_serviceToken', 'fresh-token']]),
          };
        },
      },
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap).toMatchObject({ provider: 'opencode', ok: true, plan: 'Pro' });
    expect(renewCalls).toEqual([{
      url: 'https://account.xiaomi.com/pass/serviceLogin?callback=platform',
      sso: 'cUserId=abc; passToken=def',
    }]);
    // The retry carries a rotated session cookie over the stored session.
    expect(fetchSessions).toHaveLength(2);
    expect(fetchSessions[1].cookieHeader).toContain('api-platform_serviceToken=fresh-token');
  });

  it('still reports needsReauth when the SSO renewal cannot revive the session', async () => {
    let fetches = 0;
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: SESSION }).reader,
      fetchPlans: async () => {
        fetches += 1;
        return {
          usage: { status: 401, body: { code: 401, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin' } },
          detail: { status: 401, body: { code: 401 } },
        };
      },
      renewer: { renew: async () => ({ attempted: true, completed: false, setCookies: new Map() }) },
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/401/);
    expect(fetches).toBe(1);
  });

  it('does not attempt renewal when the 401 body publishes no login URL', async () => {
    const renew = vi.fn(async () => ({ attempted: true, completed: true, setCookies: new Map<string, string>() }));
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: SESSION }).reader,
      fetchPlans: async () => ({
        usage: { status: 401, body: { code: 401 } },
        detail: { status: 401, body: { code: 401 } },
      }),
      renewer: { renew },
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(renew).not.toHaveBeenCalled();
    expect(snap!.needsReauth).toBe(true);
  });

  it('reports a failed request without fabricating windows', async () => {
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: SESSION }).reader,
      fetchPlans: async () => {
        throw Object.assign(new Error('boom'), { name: 'AbortError' });
      },
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(false);
    expect(snap!.windows).toEqual([]);
  });

  it('reports "no usage windows" when the shape changes', async () => {
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true,
      reader: readerReturning({ session: SESSION }).reader,
      fetchPlans: okFetch({ usage: usageBody([], []) }),
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/no usage windows/i);
  });
});
