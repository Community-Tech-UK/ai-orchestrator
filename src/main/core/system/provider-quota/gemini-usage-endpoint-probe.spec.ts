import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  GeminiUsageEndpointProbe,
  discoverGeminiOAuthClient,
  parseGeminiQuotaSummary,
  type AgyCredentialReadFn,
  type GeminiOAuthDiscoveryDeps,
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

/** The real AGY summary shape (groups → buckets), as returned live by AGY 1.1.1. */
function summaryBody(): unknown {
  return {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', window: 'weekly',
            remainingFraction: 0.5923018, resetTime: '2026-07-17T18:56:30Z' },
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', window: '5h',
            remainingFraction: 0.7703905, resetTime: '2026-07-11T21:31:54Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 1 },
          { bucketId: '3p-5h', displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1 },
        ],
      },
    ],
  };
}

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
/** Default keyring reader: unavailable, so tests exercise the file fallback. */
const noKeychain: AgyCredentialReadFn = async () => ({ credential: null, reason: 'not-found' });

describe('GeminiUsageEndpointProbe', () => {
  it('falls back to OAuth creds + a configured project when no keyring credential, then returns grouped windows', async () => {
    const calls: { token: string; project: string }[] = [];
    const fetchQuota: GeminiQuotaFetch = async (token, project) => {
      calls.push({ token, project });
      return { status: 200, body: summaryBody() };
    };

    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      readAgyCredential: noKeychain,
      projectId: 'cloudaicompanion-prod',
      fetchQuota,
      discoverOAuthClient: noDiscovery,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(calls).toEqual([{ token: 'gemini-access-token', project: 'cloudaicompanion-prod' }]);
    expect(snap).toMatchObject({ provider: 'antigravity', ok: true, source: 'admin-api' });
    // Five-hour before weekly within each group; Gemini group first.
    expect(snap!.windows.map((w) => `${w.id}|${w.label}|${w.used}`)).toEqual([
      'antigravity.gemini-5h|Gemini · 5-hour|22.961',
      'antigravity.gemini-weekly|Gemini · weekly|40.77',
      'antigravity.3p-5h|Claude/GPT · 5-hour|0',
      'antigravity.3p-weekly|Claude/GPT · weekly|0',
    ]);
    expect(snap!.windows[0]).toMatchObject({
      kind: 'rolling-window',
      unit: 'requests',
      limit: 100,
      resetsAt: Date.parse('2026-07-11T21:31:54Z'),
    });
  });

  it('prefers the AGY keyring credential over the oauth_creds.json file', async () => {
    const calls: string[] = [];
    const fetchQuota: GeminiQuotaFetch = async (token) => {
      calls.push(token);
      return { status: 200, body: summaryBody() };
    };
    const probe = new GeminiUsageEndpointProbe({
      // Both sources present — the keyring token must win.
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      readAgyCredential: async () => ({ credential: { accessToken: 'agy-keyring-token', expiresAt: 0 } }),
      projectId: 'cloudaicompanion-prod',
      fetchQuota,
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(calls).toEqual(['agy-keyring-token']);
    expect(snap!.ok).toBe(true);
  });

  it('seeds the project id self-healingly via loadCodeAssist', async () => {
    const loadCalls: string[] = [];
    const fetchLoadCodeAssist: GeminiLoadCodeAssistFetch = async (token) => {
      loadCalls.push(token);
      return { status: 200, project: 'pure-gravity-nm5x8' };
    };
    const fetchQuota: GeminiQuotaFetch = async () => ({ status: 200, body: summaryBody() });

    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      readAgyCredential: noKeychain,
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

  it('refreshes an expired file token using a discovered OAuth client without touching the refresh token', async () => {
    const refreshes: string[] = [];
    const refreshToken: GeminiTokenRefreshFetch = async (refreshTokenValue) => {
      refreshes.push(refreshTokenValue);
      return { accessToken: 'fresh-access-token', expiresInSec: 3600 };
    };
    const fetchQuota: GeminiQuotaFetch = async () => ({ status: 200, body: summaryBody() });

    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({
        'oauth_creds.json': JSON.stringify({
          access_token: 'expired-access-token',
          expiry_date: Date.now() - 1000,
          refresh_token: 'existing-refresh-token',
        }),
      }),
      readAgyCredential: noKeychain,
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
    const fetchQuota: GeminiQuotaFetch = async () => ({ status: 200, body: summaryBody() });

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
      readAgyCredential: noKeychain,
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

  it('flags needsReauth when neither keyring nor credential file is available (signed out)', async () => {
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': null }),
      readAgyCredential: noKeychain,
      projectId: 'cloudaicompanion-prod',
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toMatch(/not signed in/i);
  });

  it('flags needsReauth when the file token is expired and cannot be refreshed', async () => {
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({
        'oauth_creds.json': JSON.stringify({
          access_token: 'expired-access-token',
          expiry_date: Date.now() - 1000,
          refresh_token: 'existing-refresh-token',
        }),
      }),
      readAgyCredential: noKeychain,
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
      readAgyCredential: noKeychain,
      projectId: 'cloudaicompanion-prod',
      fetchQuota,
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.needsReauth).toBe(true);
  });

  it('parses summary groups into five-hour/weekly windows with clamped used percentages', () => {
    const windows = parseGeminiQuotaSummary(summaryBody() as Parameters<typeof parseGeminiQuotaSummary>[0]);
    expect(windows.map((w) => `${w.id}:${w.used}%`)).toEqual([
      'antigravity.gemini-5h:22.961%',
      'antigravity.gemini-weekly:40.77%',
      'antigravity.3p-5h:0%',
      'antigravity.3p-weekly:0%',
    ]);
  });

  it('normalizes an unknown future group when it carries a display name and remaining fraction', () => {
    const windows = parseGeminiQuotaSummary({
      groups: [
        {
          displayName: 'Future Models',
          buckets: [
            { bucketId: 'future-5h', displayName: 'Five Hour Limit', window: '5h', remainingFraction: 0.25 },
            { displayName: 'Odd bucket', window: 'monthly', remainingFraction: 0.5 },
          ],
        },
      ],
    });
    expect(windows).toEqual([
      expect.objectContaining({ id: 'antigravity.future-5h', label: 'Future Models · 5-hour', used: 75 }),
      expect.objectContaining({ id: 'antigravity.future-models-monthly', label: 'Future Models · monthly', used: 50 }),
    ]);
  });

  it('returns ok=false when loadCodeAssist cannot seed a project id', async () => {
    const probe = new GeminiUsageEndpointProbe({
      readFile: reader({ 'oauth_creds.json': CREDS_JSON }),
      readAgyCredential: noKeychain,
      fetchLoadCodeAssist: async () => ({ status: 200, project: null }),
      discoverOAuthClient: noDiscovery,
    });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/project/i);
  });
});

describe('discoverGeminiOAuthClient', () => {
  // Models the real machine: `agy` is a compiled binary in ~/.local/bin (no JS
  // in its dir), while `gemini` resolves into a JS bundle that carries the
  // client. The loop must skip past `agy` and keep going to `gemini`.
  const AGY_DIR = path.resolve('/home/u/.local/bin');
  const GEMINI_BIN_DIR = path.resolve('/home/u/.nvm/versions/node/v24/bin');
  const GEMINI_BUNDLE_DIR = path.resolve('/home/u/.nvm/versions/node/v24/lib/node_modules/@google/gemini-cli/bundle');

  function fakeFs(): GeminiOAuthDiscoveryDeps {
    return {
      searchDirs: [AGY_DIR, GEMINI_BIN_DIR],
      access: async (p: string) => {
        if (p === path.join(AGY_DIR, 'agy') || p === path.join(GEMINI_BIN_DIR, 'gemini')) return;
        throw new Error('ENOENT');
      },
      realpath: async (p: string) => {
        if (p === path.join(GEMINI_BIN_DIR, 'gemini')) return path.join(GEMINI_BUNDLE_DIR, 'gemini.js');
        return p; // agy is its own realpath
      },
      readdir: async (p: string) => {
        if (p === AGY_DIR) return ['agy', 'node', 'claude']; // no .js → no client
        if (p === GEMINI_BUNDLE_DIR) return ['gemini.js', 'chunk-AAA.js'];
        return [];
      },
      readFile: async (p: string) => {
        if (p === path.join(GEMINI_BUNDLE_DIR, 'chunk-AAA.js')) {
          return 'const OAUTH_CLIENT_ID = "the-id";\nconst OAUTH_CLIENT_SECRET = "the-secret";';
        }
        return 'no client here';
      },
    };
  }

  it('skips the compiled `agy` binary and resolves the client from the gemini bundle', async () => {
    const client = await discoverGeminiOAuthClient({}, fakeFs());
    expect(client).toEqual({ clientId: 'the-id', clientSecret: 'the-secret' });
  });

  it('returns null when no candidate bundle yields the client', async () => {
    const deps = fakeFs();
    deps.readFile = async () => 'no client anywhere';
    const client = await discoverGeminiOAuthClient({}, deps);
    expect(client).toBeNull();
  });

  it('returns null when neither binary is on the search path', async () => {
    const client = await discoverGeminiOAuthClient(
      {},
      { searchDirs: ['/nowhere'], access: async () => { throw new Error('ENOENT'); } },
    );
    expect(client).toBeNull();
  });
});
