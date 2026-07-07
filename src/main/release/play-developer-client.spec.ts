import { generateKeyPairSync, verify } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_PUBLISHER_SCOPE,
  GoogleServiceAccountTokenProvider,
  PlayDeveloperClient,
  buildGoogleServiceAccountAssertion,
} from './play-developer-client';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const serviceAccount = {
  clientEmail: 'release-bot@example.iam.gserviceaccount.com',
  privateKeyId: 'private-key-id-1',
  privateKey,
  tokenUri: 'https://oauth2.googleapis.com/token',
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
}

describe('buildGoogleServiceAccountAssertion', () => {
  it('builds a verifiable RS256 OAuth assertion for androidpublisher scope', () => {
    const assertion = buildGoogleServiceAccountAssertion({
      serviceAccount,
      scope: ANDROID_PUBLISHER_SCOPE,
      nowSeconds: 1_700_000_000,
    });
    const [header, claims, signature] = assertion.split('.');

    expect(decodeSegment(header)).toEqual({
      alg: 'RS256',
      kid: 'private-key-id-1',
      typ: 'JWT',
    });
    expect(decodeSegment(claims)).toEqual({
      iss: serviceAccount.clientEmail,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: serviceAccount.tokenUri,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      keyPair.publicKey,
      Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    )).toBe(true);
  });
});

describe('GoogleServiceAccountTokenProvider', () => {
  it('exchanges a signed assertion for an access token and caches it', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    let now = 1_700_000_000_000;
    const provider = new GoogleServiceAccountTokenProvider({
      serviceAccount,
      now: () => now,
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({
          access_token: 'ya29.token',
          expires_in: 3600,
          token_type: 'Bearer',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(provider.getAccessToken()).resolves.toBe('ya29.token');
    now += 60_000;
    await expect(provider.getAccessToken()).resolves.toBe('ya29.token');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(serviceAccount.tokenUri);
    const body = new URLSearchParams(requests[0].body);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion')).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
  });
});

describe('PlayDeveloperClient', () => {
  it('creates an edit, uploads an AAB, updates the track, and commits through Play API endpoints', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const tokenProvider = { getAccessToken: async () => 'ya29.token' };
    const client = new PlayDeveloperClient({
      tokenProvider,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        const requestUrl = String(url);
        if (requestUrl.endsWith('/edits')) {
          return jsonResponse({ id: 'edit-1' });
        }
        if (requestUrl.includes('/upload/androidpublisher/')) {
          return jsonResponse({ versionCode: 42, sha256: 'abc' });
        }
        if (requestUrl.includes('/tracks/internal')) {
          return jsonResponse({ track: 'internal', releases: [{ versionCodes: ['42'] }] });
        }
        if (requestUrl.endsWith('/edits/edit-1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW')) {
          return jsonResponse({ id: 'edit-1', expiryTimeSeconds: '1700003600' });
        }
        return jsonResponse({ error: 'unexpected' }, 404);
      },
    });

    await expect(client.createEdit('com.example.app')).resolves.toEqual({ id: 'edit-1' });
    await expect(client.uploadBundle({
      packageName: 'com.example.app',
      editId: 'edit-1',
      aab: Buffer.from('aab-bytes'),
    })).resolves.toEqual({ versionCode: 42, sha256: 'abc' });
    await expect(client.updateTrack({
      packageName: 'com.example.app',
      editId: 'edit-1',
      track: 'internal',
      releases: [{ name: '42', versionCodes: ['42'], status: 'completed' }],
    })).resolves.toEqual({ track: 'internal', releases: [{ versionCodes: ['42'] }] });
    await expect(client.commitEdit({
      packageName: 'com.example.app',
      editId: 'edit-1',
      changesInReviewBehavior: 'ERROR_IF_IN_REVIEW',
    })).resolves.toEqual({ id: 'edit-1', expiryTimeSeconds: '1700003600' });

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits'],
      ['POST', 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.example.app/edits/edit-1/bundles?uploadType=media'],
      ['PUT', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits/edit-1/tracks/internal'],
      ['POST', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits/edit-1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW'],
    ]);
    expect(requests.every((request) =>
      (request.init.headers as Record<string, string>).authorization === 'Bearer ya29.token',
    )).toBe(true);
    expect(requests[2].init.body).toBe(JSON.stringify({
      track: 'internal',
      releases: [{ name: '42', versionCodes: ['42'], status: 'completed' }],
    }));
  });

  it('redacts OAuth material from Play API errors', async () => {
    const client = new PlayDeveloperClient({
      tokenProvider: { getAccessToken: async () => 'ya29.secret-token' },
      fetch: async () => jsonResponse({
        error: {
          code: 403,
          message: 'token ya29.secret-token denied',
        },
      }, 403),
    });

    await expect(client.createEdit('com.example.app')).rejects.toThrow(/play_developer_api_error:403/);
    await expect(client.createEdit('com.example.app')).rejects.not.toThrow('ya29.secret-token');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
