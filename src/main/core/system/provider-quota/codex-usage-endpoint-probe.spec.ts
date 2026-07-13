import { describe, it, expect } from 'vitest';
import {
  CodexUsageEndpointProbe,
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
