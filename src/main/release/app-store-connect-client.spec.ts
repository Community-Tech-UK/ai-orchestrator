import { generateKeyPairSync, verify } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  AppStoreConnectClient,
  buildAppStoreConnectJwt,
} from './app-store-connect-client';

const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
}

describe('buildAppStoreConnectJwt', () => {
  it('builds a verifiable ES256 App Store Connect token capped to twenty minutes', () => {
    const jwt = buildAppStoreConnectJwt({
      keyId: 'ABC123DEFG',
      issuerId: 'issuer-123',
      privateKey,
      nowSeconds: 1_700_000_000,
      ttlSeconds: 3_600,
      scope: ['GET /v1/apps'],
    });
    const [header, claims, signature] = jwt.split('.');

    expect(decodeSegment(header)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    expect(decodeSegment(claims)).toEqual({
      iss: 'issuer-123',
      iat: 1_700_000_000,
      exp: 1_700_001_200,
      aud: 'appstoreconnect-v1',
      scope: ['GET /v1/apps'],
    });
    expect(verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    )).toBe(true);
  });
});

describe('AppStoreConnectClient', () => {
  it('sends bearer-authenticated JSON requests to the ASC API', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = new AppStoreConnectClient({
      keyId: 'ABC123DEFG',
      issuerId: 'issuer-123',
      privateKey,
      nowSeconds: () => 1_700_000_000,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ id: 'app-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await client.request('/v1/apps', {
      query: { 'filter[bundleId]': 'com.example.app' },
      scope: ['GET /v1/apps?filter[bundleId]=com.example.app'],
    });

    expect(result).toEqual({ data: [{ id: 'app-1' }] });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      'https://api.appstoreconnect.apple.com/v1/apps?filter%5BbundleId%5D=com.example.app',
    );
    expect(requests[0].init.method).toBe('GET');
    expect(requests[0].init.headers).toMatchObject({
      accept: 'application/json',
    });
    expect((requests[0].init.headers as Record<string, string>).authorization)
      .toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
  });

  it('redacts authorization material from request errors', async () => {
    const client = new AppStoreConnectClient({
      keyId: 'ABC123DEFG',
      issuerId: 'issuer-123',
      privateKey,
      fetch: async () => new Response(JSON.stringify({
        errors: [{ status: '401', detail: 'bad token eyJ.secret.parts' }],
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    });

    await expect(client.request('/v1/apps')).rejects.toThrow(/app_store_connect_api_error:401/);
    await expect(client.request('/v1/apps')).rejects.not.toThrow(privateKey);
    await expect(client.request('/v1/apps')).rejects.not.toThrow(/eyJ\.secret\.parts/);
  });

  it('uploads asset parts to HTTPS pre-signed URLs without ASC bearer authorization', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = new AppStoreConnectClient({
      keyId: 'ABC123DEFG',
      issuerId: 'issuer-123',
      privateKey,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: 200 });
      },
    });

    await client.uploadAssetPart({
      method: 'PUT',
      url: 'https://upload.example.test/part?Signature=sensitive-query-value',
      headers: {
        'Content-Type': 'image/png',
        'x-upload-token': 'operation-header',
      },
      body: Buffer.from('part-bytes'),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('Signature=sensitive-query-value');
    expect(requests[0].init.method).toBe('PUT');
    expect(requests[0].init.headers).toEqual({
      'Content-Type': 'image/png',
      'x-upload-token': 'operation-header',
    });
    expect(requests[0].init.headers).not.toHaveProperty('authorization');
    expect(Buffer.from(requests[0].init.body as Uint8Array).toString()).toBe('part-bytes');
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects non-HTTPS asset URLs and redacts pre-signed query secrets from failures', async () => {
    const client = new AppStoreConnectClient({
      keyId: 'ABC123DEFG',
      issuerId: 'issuer-123',
      privateKey,
      fetch: async () => new Response(
        'upload failed for https://upload.example.test/part?Signature=never-log-me',
        { status: 500 },
      ),
    });

    await expect(client.uploadAssetPart({
      method: 'PUT',
      url: 'http://upload.example.test/part?Signature=never-log-me',
      headers: {},
      body: Buffer.from('part'),
    })).rejects.toThrow('app_store_connect_upload_url_invalid:https_required');

    const upload = client.uploadAssetPart({
      method: 'PUT',
      url: 'https://upload.example.test/part?Signature=never-log-me',
      headers: {},
      body: Buffer.from('part'),
    });
    await expect(upload).rejects.toThrow(/app_store_connect_upload_error:500/);
    await expect(upload).rejects.not.toThrow('never-log-me');
  });
});
