import { describe, it, expect } from 'vitest';
import {
  CursorUsageSummaryProbe,
  parseCursorUsageSummaryPayload,
  type CursorUsageFetch,
} from './cursor-usage-summary-probe';
import type { CursorCredentialResult } from './cursor-credentials-reader';

const VALID_CREDENTIAL: CursorCredentialResult = {
  credential: {
    token: 'jwt-token',
    subject: 'user-123',
    expiresAt: Date.now() + 60 * 60 * 1000,
  },
};

const SUMMARY_BODY = {
  membershipType: 'pro',
  billingCycleEnd: '2026-07-01T00:00:00Z',
  individualUsage: {
    plan: {
      enabled: true,
      used: 4200,
      limit: 10000,
      totalPercentUsed: 42,
    },
    onDemand: {
      enabled: true,
      used: 250,
      limit: 10000,
    },
  },
};

function reader(result: CursorCredentialResult): { read: () => Promise<CursorCredentialResult> } {
  return { read: async () => result };
}

function fetchUsage(status: number, body: unknown): CursorUsageFetch {
  return async () => ({ status, body });
}

const signal = () => new AbortController().signal;

describe('CursorUsageSummaryProbe', () => {
  it('produces included and on-demand windows from Cursor usage-summary', async () => {
    const probe = new CursorUsageSummaryProbe({
      credentialsReader: reader(VALID_CREDENTIAL),
      fetchUsage: fetchUsage(200, SUMMARY_BODY),
    });

    const snap = await probe.probe({ signal: signal() });

    expect(snap!.ok).toBe(true);
    expect(snap!.provider).toBe('cursor');
    expect(snap!.source).toBe('admin-api');
    expect(snap!.plan).toBe('pro');

    const byId = Object.fromEntries(snap!.windows.map((w) => [w.id, w]));
    expect(byId['cursor.included'].used).toBe(42);
    expect(byId['cursor.included'].limit).toBe(100);
    expect(byId['cursor.included'].remaining).toBe(58);
    expect(byId['cursor.included'].resetsAt).toBe(Date.parse('2026-07-01T00:00:00Z'));
    expect(byId['cursor.on-demand'].used).toBe(2.5);
    expect(byId['cursor.on-demand'].limit).toBe(100);
  });

  it('trusts Cursor totalPercentUsed for the included plan window', () => {
    const windows = parseCursorUsageSummaryPayload({
      individualUsage: {
        plan: {
          enabled: true,
          used: 0,
          limit: 0,
          totalPercentUsed: 100,
        },
      },
    });

    expect(windows).toHaveLength(1);
    expect(windows[0].id).toBe('cursor.included');
    expect(windows[0].used).toBe(100);
    expect(windows[0].limit).toBe(100);
  });

  it('reports signed-out when no Cursor session token is available', async () => {
    const probe = new CursorUsageSummaryProbe({
      credentialsReader: reader({ credential: null, reason: 'not-found' }),
      fetchUsage: fetchUsage(200, SUMMARY_BODY),
    });

    const snap = await probe.probe({ signal: signal() });

    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/not signed in/i);
  });

  it('does not fetch when the Cursor session token is expired', async () => {
    let fetched = false;
    const probe = new CursorUsageSummaryProbe({
      credentialsReader: reader({ credential: null, reason: 'expired' }),
      fetchUsage: async () => {
        fetched = true;
        return { status: 200, body: SUMMARY_BODY };
      },
    });

    const snap = await probe.probe({ signal: signal() });

    expect(fetched).toBe(false);
    expect(snap!.error).toMatch(/expired/i);
  });

  it('maps rejected session cookies to ok=false', async () => {
    const probe = new CursorUsageSummaryProbe({
      credentialsReader: reader(VALID_CREDENTIAL),
      fetchUsage: fetchUsage(401, null),
    });

    const snap = await probe.probe({ signal: signal() });

    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/rejected|re-login/i);
  });
});
