import { describe, it, expect } from 'vitest';
import {
  GeminiUsageEndpointProbe,
  parseGeminiQuotaPayload,
  type GeminiQuotaFileReader,
  type GeminiQuotaFetch,
  type GeminiTokenRefreshOptions,
  type GeminiTokenRefreshFetch,
} from './gemini-usage-endpoint-probe';

const CREDS_JSON = JSON.stringify({
  access_token: 'gemini-access-token',
  expiry_date: Date.now() + 60 * 60 * 1000,
  refresh_token: 'gemini-refresh-token',
});

function reader(files: Record<string, string | null>): GeminiQuotaFileReader {
  return async (filePath) => {
    for (const [suffix, content] of Object.entries(files)) {
      if (filePath.endsWith(suffix)) {
        if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return content;
      }
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

describe('GeminiUsageEndpointProbe', () => {
  it('reads Gemini OAuth creds and project id, then returns grouped quota percentages', async () => {
    const calls: { token: string; project: string }[] = [];
    const fetchQuota: GeminiQuotaFetch = async (token, project) => {
      calls.push({ token, project });
      return {
        status: 200,
        body: {
          buckets: [
            { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-06-06T00:00:00Z' },
            { modelId: 'gemini-2.5-flash', remainingFraction: 0.9, resetTime: '2026-06-06T00:00:00Z' },
          ],
        },
      };
    };

    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({
        'oauth_creds.json': CREDS_JSON,
        'gemini_project': 'cloudaicompanion-prod',
      }),
      fetchQuota,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(calls).toEqual([{ token: 'gemini-access-token', project: 'cloudaicompanion-prod' }]);
    expect(snap).toMatchObject({ provider: 'antigravity', ok: true, source: 'admin-api' });
    expect(snap!.windows).toEqual([
      expect.objectContaining({
        id: 'gemini.pro-daily',
        label: 'Pro daily',
        used: 75,
        remaining: 25,
      }),
      expect.objectContaining({
        id: 'gemini.flash-daily',
        label: 'Flash daily',
        used: 10,
        remaining: 90,
      }),
    ]);
  });

  it('refreshes an expired access token without touching the stored refresh token', async () => {
    const refreshes: string[] = [];
    const refreshToken: GeminiTokenRefreshFetch = async (refreshTokenValue) => {
      refreshes.push(refreshTokenValue);
      return { accessToken: 'fresh-access-token', expiresInSec: 3600 };
    };
    const fetchQuota: GeminiQuotaFetch = async (token) => ({
      status: 200,
      body: { buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5 }] },
      tokenSeen: token,
    } as { status: number; body: unknown; tokenSeen: string });

    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({
        'oauth_creds.json': JSON.stringify({
          access_token: 'expired-access-token',
          expiry_date: Date.now() - 1000,
          refresh_token: 'existing-refresh-token',
        }),
        'gemini_project': 'cloudaicompanion-prod',
      }),
      refreshToken,
      fetchQuota,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(refreshes).toEqual(['existing-refresh-token']);
    expect(snap!.ok).toBe(true);
  });

  it('passes OAuth client metadata from runtime credentials when refreshing', async () => {
    const refreshCalls: GeminiTokenRefreshOptions[] = [];
    const refreshToken: GeminiTokenRefreshFetch = async (_refreshTokenValue, opts) => {
      refreshCalls.push(opts);
      return { accessToken: 'fresh-access-token', expiresInSec: 3600 };
    };
    const fetchQuota: GeminiQuotaFetch = async () => ({
      status: 200,
      body: { buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5 }] },
    });

    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({
        'oauth_creds.json': JSON.stringify({
          access_token: 'expired-access-token',
          expiry_date: Date.now() - 1000,
          refresh_token: 'existing-refresh-token',
          client_id: 'fixture-client-id',
          client_secret: 'fixture-client-marker',
        }),
        'gemini_project': 'cloudaicompanion-prod',
      }),
      refreshToken,
      fetchQuota,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(true);
    expect(refreshCalls).toEqual([
      expect.objectContaining({
        clientId: 'fixture-client-id',
        clientSecret: 'fixture-client-marker',
      }),
    ]);
  });

  it('parses quota buckets by model family using the lowest remaining fraction', () => {
    const windows = parseGeminiQuotaPayload({
      buckets: [
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.8 },
        { modelId: 'gemini-1.5-pro', remainingFraction: 0.2 },
        { modelId: 'gemini-2.5-flash-lite', remainingFraction: 0.7 },
        { modelId: 'gemini-2.5-flash', remainingFraction: 0.4 },
      ],
    });

    expect(windows.map((w) => `${w.id}:${w.used}%`)).toEqual([
      'gemini.pro-daily:80%',
      'gemini.flash-lite-daily:30%',
      'gemini.flash-daily:60%',
    ]);
  });

  it('returns ok=false when no project id can be found', async () => {
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({
        'oauth_creds.json': CREDS_JSON,
        'gemini_project': null,
      }),
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/project/i);
  });
});
