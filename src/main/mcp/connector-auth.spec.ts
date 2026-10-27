import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import { McpSecretStorage } from './secret-storage';
import { ConnectorAuthService } from './connector-auth-service';

const dbs: SqliteDriver[] = [];
function setup(
  options: {
    fetch?: typeof fetch;
    openBrowser?: (url: string) => Promise<void>;
    onSignInRequired?: (name: string) => void;
  } = {},
) {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  const secrets = new McpSecretStorage({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
      decryptString: (b) => b.toString().split('').reverse().join(''),
    },
  });
  const repo = new OrchestratorMcpRepository(db, secrets);
  const record = repo.upsert({
    name: 'example',
    transport: 'http',
    url: 'https://example.test/mcp',
    authType: 'bearer',
  }).record;
  return {
    db,
    repo,
    secrets,
    record,
    service: new ConnectorAuthService({
      db,
      secrets,
      repo,
      openBrowser:
        options.openBrowser ??
        (async () => {
          throw new Error('must not open browser');
        }),
      fetch: options.fetch,
      onSignInRequired: options.onSignInRequired,
    }),
  };
}
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
describe('connector credentials', () => {
  it('encrypts bearer credentials and returns only a safe status', async () => {
    const { db, record, service } = setup();
    service.setBearerToken(record.id, 'PLACEHOLDER_BEARER');
    expect(await service.getAccessToken(record.id)).toBe('PLACEHOLDER_BEARER');
    expect(JSON.stringify(db.prepare('SELECT * FROM connector_auth').all())).not.toContain(
      'PLACEHOLDER_BEARER',
    );
    expect(service.status(record.id)).toEqual({ state: 'signed-in' });
    service.signOut(record.id);
    await expect(service.getAccessToken(record.id)).rejects.toThrow('Sign in to example again');
  });
  it('reports a rejected static bearer as expired and sends only one sign-in notice', async () => {
    const notices: string[] = [];
    const { record, service } = setup({ onSignInRequired: (name) => notices.push(name) });
    service.setBearerToken(record.id, 'PLACEHOLDER_BEARER');
    await expect(service.getAccessToken(record.id, true)).rejects.toThrow(
      'Sign in to example again',
    );
    await expect(service.getAccessToken(record.id, true)).rejects.toThrow(
      'Sign in to example again',
    );
    expect(service.status(record.id)).toEqual({ state: 'expired' });
    expect(notices).toEqual(['example']);
  });
  it('does not invalidate newer credentials when an old refresh finishes after reconfiguration', async () => {
    let started!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fixture = setup({
      fetch: async (input) => {
        if (String(input).endsWith('/token')) {
          started();
          return response;
        }
        return Response.json({
          resource: 'https://example.test/mcp',
          authorization_servers: ['https://auth.example.test'],
        });
      },
    });
    const { db, repo, secrets, record, service } = fixture;
    repo.upsert({ ...record, authType: 'oauth' });
    const state = {
      binding: JSON.stringify([record.url, 'oauth', null]),
      redirectUrl: 'http://127.0.0.1/callback',
      expiresAt: 1,
      client: { client_id: 'PLACEHOLDER_CLIENT', issuer: 'https://auth.example.test' },
      tokens: {
        access_token: 'PLACEHOLDER_OLD',
        refresh_token: 'PLACEHOLDER_REFRESH',
        token_type: 'Bearer',
        issuer: 'https://auth.example.test',
      },
      discovery: {
        authorizationServerUrl: 'https://auth.example.test',
        authorizationServerMetadata: {
          issuer: 'https://auth.example.test',
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/token',
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['none'],
        },
      },
    };
    db.prepare('INSERT INTO connector_auth(connector_id,encrypted_json) VALUES (?,?)').run(
      record.id,
      JSON.stringify(secrets.encryptSecret(JSON.stringify(state))),
    );
    const old = service.getAccessToken(record.id);
    await refreshing;
    repo.upsert({ ...record, authType: 'bearer' });
    service.setBearerToken(record.id, 'PLACEHOLDER_NEW');
    finish(
      Response.json({ access_token: 'PLACEHOLDER_STALE', token_type: 'Bearer', expires_in: 3600 }),
    );
    await expect(old).rejects.toThrow();
    expect(await service.getAccessToken(record.id)).toBe('PLACEHOLDER_NEW');
    expect(service.status(record.id)).toEqual({ state: 'signed-in' });
  });
  it('never releases a saved credential after the endpoint changes', async () => {
    const { record, repo, service } = setup();
    service.setBearerToken(record.id, 'PLACEHOLDER_BEARER');
    repo.upsert({ ...record, url: 'https://other.test/mcp' });
    await expect(service.getAccessToken(record.id)).rejects.toThrow('Sign in to example again');
  });
  it('does not start interactive sign-in when no refresh token is available', async () => {
    const { record, repo, service } = setup();
    repo.upsert({ ...record, authType: 'oauth' });
    await expect(service.getAccessToken(record.id)).rejects.toThrow('Sign in to example again');
  });
});

describe('connector OAuth integration', () => {
  it('uses registration and PKCE, persists encrypted tokens and refreshes once for concurrent callers', async () => {
    let registeredRedirect = '';
    let refreshes = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const params = new URLSearchParams(String(init?.body ?? ''));
      if (url.includes('oauth-protected-resource'))
        return Response.json({
          resource: 'https://example.test/mcp',
          authorization_servers: ['https://auth.example.test'],
        });
      if (url.includes('.well-known'))
        return Response.json({
          issuer: 'https://auth.example.test',
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/token',
          registration_endpoint: 'https://auth.example.test/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      if (url.endsWith('/register')) {
        const body = JSON.parse(String(init?.body));
        registeredRedirect = body.redirect_uris[0];
        return Response.json({ ...body, client_id: 'PLACEHOLDER_CLIENT' });
      }
      if (url.endsWith('/token')) {
        if (params.get('grant_type') === 'refresh_token') refreshes++;
        else {
          expect(params.get('code')).toBe('PLACEHOLDER_CODE');
          expect(params.get('code_verifier')!.length).toBeGreaterThan(40);
        }
        return Response.json({
          access_token: refreshes ? 'PLACEHOLDER_REFRESHED' : 'PLACEHOLDER_ACCESS',
          refresh_token: 'PLACEHOLDER_REFRESH',
          token_type: 'Bearer',
          expires_in: refreshes ? 3600 : 1,
        });
      }
      throw new Error('Unexpected fake authorization request');
    };
    const { db, repo, record, service } = setup({
      fetch: fakeFetch,
      openBrowser: async (raw) => {
        const url = new URL(raw);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('redirect_uri')).toBe(registeredRedirect);
        const callback = new URL(registeredRedirect);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('code', 'PLACEHOLDER_CODE');
        await fetch(callback);
      },
    });
    repo.upsert({ ...record, authType: 'oauth' });
    await service.signIn(record.id);
    expect(service.status(record.id)).toEqual({ state: 'signed-in' });
    expect(
      await Promise.all([service.getAccessToken(record.id), service.getAccessToken(record.id)]),
    ).toEqual(['PLACEHOLDER_REFRESHED', 'PLACEHOLDER_REFRESHED']);
    expect(refreshes).toBe(1);
    expect(JSON.stringify(db.prepare('SELECT * FROM connector_auth').all())).not.toContain(
      'PLACEHOLDER_ACCESS',
    );
  });
});
