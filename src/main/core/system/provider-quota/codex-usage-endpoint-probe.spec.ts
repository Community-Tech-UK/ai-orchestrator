import { describe, it, expect } from 'vitest';
import {
  CodexUsageEndpointProbe,
  parseCodexUsageAccess,
  parseCodexUsagePayload,
  type CodexAuthFileReader,
  type CodexUsageFetch,
} from './codex-usage-endpoint-probe';

const AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: 'codex-access-token',
    account_id: 'acct-123',
  },
});

function reader(content: string | null): CodexAuthFileReader {
  return async () => {
    if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

describe('parseCodexUsageAccess', () => {
  // Shape of a real wham/usage response for an account whose weekly window is spent but which has a top-up.
  const toppedUp = {
    rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 1_789_820_332 } },
    credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '2500.0000000000' },
    spend_control: { reached: false },
  };

  it('reads included usage and credits separately', () => {
    expect(parseCodexUsageAccess(toppedUp)).toEqual({ ordinaryUsageAllowed: false, creditsAvailable: true });
  });

  it('reports no credits when the balance is empty, the overage limit or a spend limit is reached', () => {
    expect(parseCodexUsageAccess({ ...toppedUp, credits: { has_credits: false, unlimited: false } })?.creditsAvailable).toBe(false);
    expect(parseCodexUsageAccess({ ...toppedUp, credits: { ...toppedUp.credits, overage_limit_reached: true } })?.creditsAvailable).toBe(false);
    expect(parseCodexUsageAccess({ ...toppedUp, spend_control: { reached: true } })?.creditsAvailable).toBe(false);
  });

  it('returns null when the payload says nothing about access', () => {
    expect(parseCodexUsageAccess({ rate_limit: { primary_window: { used_percent: 5 } } })).toBeNull();
  });

  it('attaches usage access to the probe snapshot', async () => {
    const probe = new CodexUsageEndpointProbe({
      readFile: reader(AUTH_JSON),
      fetchUsage: async () => ({ status: 200, body: toppedUp }),
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap?.usageAccess).toEqual({ ordinaryUsageAllowed: false, creditsAvailable: true });
  });
});

describe('CodexUsageEndpointProbe', () => {
  it('reads Codex auth read-only, fetches wham usage, and returns percentage windows', async () => {
    const calls: { token: string; accountId: string }[] = [];
    const fetchUsage: CodexUsageFetch = async (token, accountId) => {
      calls.push({ token, accountId });
      return {
        status: 200,
        body: {
          rate_limit: {
            limit_reached: false,
            primary_window: { used_percent: 12.3, reset_at: 1_717_012_345 },
            secondary_window: { used_percent: 45.6, reset_at: 1_717_099_999 },
          },
        },
      };
    };

    const probe = new CodexUsageEndpointProbe({
      readFile: reader(AUTH_JSON),
      fetchUsage,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(calls).toEqual([{ token: 'codex-access-token', accountId: 'acct-123' }]);
    expect(snap).toMatchObject({ provider: 'codex', ok: true, source: 'admin-api' });
    expect(snap!.windows).toEqual([
      expect.objectContaining({
        id: 'codex.5h',
        label: '5-hour',
        used: 12.3,
        limit: 100,
        remaining: 87.7,
        resetsAt: 1_717_012_345_000,
      }),
      expect.objectContaining({
        id: 'codex.weekly',
        label: 'Weekly',
        used: 45.6,
        limit: 100,
        remaining: 54.4,
        resetsAt: 1_717_099_999_000,
      }),
    ]);
  });

  it('parses the wham usage payload into 5-hour and weekly percent windows', () => {
    const windows = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 95, reset_at: 1_717_012_345 },
        secondary_window: { used_percent: 7, reset_at: null },
      },
    });

    expect(windows.map((w) => `${w.id}:${w.used}%`)).toEqual([
      'codex.5h:95%',
      'codex.weekly:7%',
    ]);
  });

  it('treats a sole long-reset primary window as the weekly quota during the temporary 5-hour removal', () => {
    const now = Date.UTC(2026, 6, 13, 0, 0, 0);
    const windows = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 4, reset_at: (now + 6 * 24 * 60 * 60 * 1000) / 1000 },
        secondary_window: { used_percent: null, reset_at: null },
      },
    }, now);

    expect(windows).toEqual([
      expect.objectContaining({
        id: 'codex.weekly',
        label: 'Weekly',
        used: 4,
      }),
    ]);
  });

  it('returns ok=false when auth.json is absent instead of mutating refresh tokens', async () => {
    const probe = new CodexUsageEndpointProbe({ readFile: reader(null) });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/not signed in|auth\.json/i);
  });
});
