import { describe, it, expect } from 'vitest';
import {
  GeminiUsageEndpointProbe,
  parseGeminiQuotaPayload,
  type GeminiQuotaFileReader,
  type GeminiQuotaFetch,
  type GeminiLoadCodeAssistFetch,
  type GeminiOAuthClientDiscovery,
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

/** Default test discovery: never hit the real filesystem for the OAuth client. */
const noDiscovery: GeminiOAuthClientDiscovery = async () => null;

describe('GeminiUsageEndpointProbe', () => {
  it('reads OAuth creds and a configured project, then returns grouped quota percentages', async () => {
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
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      projectId: 'cloudaicompanion-prod',
      fetchQuota,
      discoverOAuthClient: noDiscovery,
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

  it('seeds the project id self-healingly via loadCodeAssist', async () => {
    const loadCalls: string[] = [];
    const fetchLoadCodeAssist: GeminiLoadCodeAssistFetch = async (token) => {
      loadCalls.push(token);
      return { status: 200, project: 'pure-gravity-nm5x8' };
    };
    const fetchQuota: GeminiQuotaFetch = async (_token, project) => ({
      status: 200,
      body: { buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5 }] },
      projectSeen: project,
    } as { status: number; body: unknown; projectSeen: string });

    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      fetchLoadCodeAssist,
      fetchQuota,
      discoverOAuthClient: noDiscovery,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(loadCalls).toEqual(['gemini-access-token']);
    expect(snap!.ok).toBe(true);

    // Second probe must reuse the cached project (no extra loadCodeAssist call).
    const snap2 = await probe.probe({ signal: new AbortController().signal });
    expect(loadCalls).toEqual(['gemini-access-token']);
    expect(snap2!.ok).toBe(true);
  });

  it('refreshes an expired token using a discovered OAuth client without touching the refresh token', async () => {
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
      }),
      projectId: 'cloudaicompanion-prod',
      refreshToken,
      fetchQuota,
      discoverOAuthClient: async () => ({ clientId: 'discovered-id', clientSecret: 'discovered-secret' }),
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(refreshes).toEqual(['existing-refresh-token']);
    expect(snap!.ok).toBe(true);

    // A second poll reuses the cached access token — no extra refresh.
    const snap2 = await probe.probe({ signal: new AbortController().signal });
    expect(refreshes).toEqual(['existing-refresh-token']);
    expect(snap2!.ok).toBe(true);
  });

  it('prefers OAuth client metadata from the creds file over discovery when refreshing', async () => {
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
      }),
      projectId: 'cloudaicompanion-prod',
      refreshToken,
      fetchQuota,
      discoverOAuthClient: noDiscovery,
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

  it('flags needsReauth when there is no credential file (signed out)', async () => {
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': null }),
      projectId: 'cloudaicompanion-prod',
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/not signed in/i);
  });

  it('flags needsReauth when the token is expired and cannot be refreshed', async () => {
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({
        'oauth_creds.json': JSON.stringify({
          access_token: 'expired-access-token',
          expiry_date: Date.now() - 1000,
          refresh_token: 'existing-refresh-token',
        }),
      }),
      projectId: 'cloudaicompanion-prod',
      // No env client, no creds client, discovery returns nothing → can't refresh.
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/could not be refreshed/i);
  });

  it('flags needsReauth on a 401 from the quota endpoint', async () => {
    const fetchQuota: GeminiQuotaFetch = async () => ({ status: 401, body: {} });
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      projectId: 'cloudaicompanion-prod',
      fetchQuota,
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
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

  it('returns ok=false when loadCodeAssist cannot seed a project id', async () => {
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      fetchLoadCodeAssist: async () => ({ status: 200, project: null }),
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/project/i);
  });
});
