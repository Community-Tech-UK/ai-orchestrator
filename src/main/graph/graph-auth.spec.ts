import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type AuthorizationCodePayload,
  type AuthorizationCodeRequest,
  type AuthorizationUrlRequest,
  type Configuration,
  type DeviceCodeRequest,
  type ISerializableTokenCache,
  type SilentFlowRequest,
  type TokenCacheContext,
} from '@azure/msal-node';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { McpSecretStorage } from '../mcp/secret-storage';
import {
  GraphAuthManager,
  type GraphPublicClientApplication,
} from './graph-auth';
import { GraphTokenStore } from './graph-token-store';

const dbs: SqliteDriver[] = [];

const account: AccountInfo = {
  homeAccountId: 'home-account-id',
  environment: 'login.example.test',
  tenantId: 'tenant-id',
  username: 'user@example.test',
  localAccountId: 'local-account-id',
};

const secondAccount: AccountInfo = {
  homeAccountId: 'second-home-account-id',
  environment: 'login.example.test',
  tenantId: 'second-tenant-id',
  username: 'second@example.test',
  localAccountId: 'second-local-account-id',
};

function authResult(overrides: Partial<AuthenticationResult> = {}): AuthenticationResult {
  return {
    authority: 'https://login.example.test/common',
    uniqueId: 'unique-id',
    tenantId: account.tenantId,
    scopes: ['Calendars.ReadWrite'],
    account,
    idToken: 'id-token-placeholder',
    idTokenClaims: {},
    accessToken: 'access-token-placeholder',
    fromCache: false,
    expiresOn: new Date(10_000),
    tokenType: 'Bearer',
    correlationId: 'correlation-id',
    ...overrides,
  };
}

function openStore(): GraphTokenStore {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  const secrets = new McpSecretStorage({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`wrapped:${plain}`, 'utf8'),
      decryptString: (encrypted) =>
        encrypted.toString('utf8').replace(/^wrapped:/, ''),
    },
  });
  return new GraphTokenStore(db, secrets, () => 100);
}

function createFakeClient(options: {
  interactiveResult?: AuthenticationResult;
  serializedCache?: string;
} = {}): GraphPublicClientApplication {
  return {
    getAuthCodeUrl: async (request: AuthorizationUrlRequest) => {
      const url = new URL('https://login.example.test/authorize');
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('state', request.state ?? '');
      return url.toString();
    },
    acquireTokenByCode: async (_request: AuthorizationCodeRequest) =>
      options.interactiveResult ?? authResult(),
    acquireTokenByDeviceCode: async (_request: DeviceCodeRequest) => authResult(),
    acquireTokenSilent: async (_request: SilentFlowRequest) => authResult(),
    getAllAccounts: async () => [account],
    signOut: async () => undefined,
    getTokenCache: () => ({
      serialize: () => options.serializedCache ?? 'serialized-msal-cache',
    }),
  };
}

describe('GraphAuthManager', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
  });

  it('uses MSAL PKCE, state, nonce and form-post authorization and persists only encrypted cache metadata', async () => {
    const store = openStore();
    const openedUrls: string[] = [];
    let configuration: Configuration | undefined;
    let authorizationRequest: AuthorizationUrlRequest | undefined;
    let tokenRequest: AuthorizationCodeRequest | undefined;
    let tokenPayload: AuthorizationCodePayload | undefined;
    const client = createFakeClient({ serializedCache: 'serialized-msal-cache' });
    const getAuthCodeUrl = client.getAuthCodeUrl;
    client.getAuthCodeUrl = async (request) => {
      authorizationRequest = request;
      return getAuthCodeUrl(request);
    };
    client.acquireTokenByCode = async (request, payload) => {
      tokenRequest = request;
      tokenPayload = payload;
      return authResult();
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: (value) => {
        configuration = value;
        return client;
      },
      openExternal: async (url) => {
        openedUrls.push(url);
        await completeAuthorization(url);
      },
    });

    const connected = await manager.connectAccount();

    expect(connected).toEqual({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(openedUrls).toHaveLength(1);
    expect(new URL(openedUrls[0]!).origin).toBe('https://login.example.test');
    expect(configuration?.auth).toEqual({
      clientId: 'client-id',
      authority: 'https://login.microsoftonline.com/common',
    });
    expect(authorizationRequest?.scopes).toEqual([
      'Calendars.ReadWrite',
      'offline_access',
      'openid',
      'profile',
      'User.Read',
    ]);
    expect(authorizationRequest).toMatchObject({
      prompt: 'select_account',
      responseMode: 'form_post',
      codeChallengeMethod: 'S256',
    });
    expect(authorizationRequest?.state).toEqual(expect.any(String));
    expect(authorizationRequest?.nonce).toEqual(expect.any(String));
    expect(authorizationRequest?.nonce).not.toBe(authorizationRequest?.state);
    expect(authorizationRequest?.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    expect(tokenRequest).toMatchObject({
      code: 'code-placeholder',
      redirectUri: authorizationRequest?.redirectUri,
      state: authorizationRequest?.state,
      nonce: authorizationRequest?.nonce,
      authority: 'https://login.microsoftonline.com/common',
    });
    expect(createHash('sha256').update(tokenRequest!.codeVerifier!).digest('base64url'))
      .toBe(authorizationRequest?.codeChallenge);
    expect(tokenPayload).toEqual({ code: 'code-placeholder', state: authorizationRequest?.state });
    expect(store.getTokenCache(account.homeAccountId)).toBe(
      'serialized-msal-cache',
    );
    expect(JSON.stringify(connected)).not.toContain('access-token-placeholder');
  });

  it('acquires an access token silently for the requested stored account', async () => {
    const store = openStore();
    store.upsertAccount({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      tokenCache: 'serialized-msal-cache',
    });
    let silentRequest: SilentFlowRequest | undefined;
    const client = createFakeClient();
    client.acquireTokenSilent = async (request) => {
      silentRequest = request;
      return authResult();
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
    });

    await expect(manager.getAccessToken(account.homeAccountId)).resolves.toBe(
      'access-token-placeholder',
    );
    expect(silentRequest).toEqual({
      account,
      scopes: [
        'Calendars.ReadWrite',
        'offline_access',
        'openid',
        'profile',
        'User.Read',
      ],
    });
  });

  it('hydrates and persists MSAL cache changes through the encrypted token store plugin', async () => {
    const store = openStore();
    store.upsertAccount({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      tokenCache: 'initial-serialized-cache',
    });
    let configuration: Configuration | undefined;
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: (value) => {
        configuration = value;
        return createFakeClient();
      },
    });
    await manager.getAccessToken(account.homeAccountId);
    const plugin = configuration?.cache?.cachePlugin;
    const deserialized: string[] = [];
    const tokenCache: ISerializableTokenCache = {
      deserialize: (cache) => {
        deserialized.push(cache);
      },
      serialize: () => 'refreshed-serialized-cache',
    };

    await plugin?.beforeCacheAccess({
      tokenCache,
      cacheHasChanged: false,
    } as unknown as TokenCacheContext);
    expect(deserialized).toEqual(['initial-serialized-cache']);

    await plugin?.afterCacheAccess({
      tokenCache,
      cacheHasChanged: true,
    } as unknown as TokenCacheContext);
    expect(store.getTokenCache(account.homeAccountId)).toBe(
      'refreshed-serialized-cache',
    );
  });

  it('reuses a memory-cached access token only while it remains outside the expiry skew', async () => {
    const store = openStore();
    store.upsertAccount({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      tokenCache: 'serialized-msal-cache',
    });
    let now = 0;
    let silentCalls = 0;
    const client = createFakeClient();
    client.acquireTokenSilent = async () => {
      silentCalls += 1;
      return authResult({
        accessToken:
          silentCalls === 1
            ? 'first-access-token-placeholder'
            : 'refreshed-access-token-placeholder',
        expiresOn: new Date(600_000),
      });
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
      now: () => now,
    });

    await expect(manager.getAccessToken(account.homeAccountId)).resolves.toBe(
      'first-access-token-placeholder',
    );
    now = 100_000;
    await expect(manager.getAccessToken(account.homeAccountId)).resolves.toBe(
      'first-access-token-placeholder',
    );
    expect(silentCalls).toBe(1);

    now = 480_000;
    await expect(manager.getAccessToken(account.homeAccountId)).resolves.toBe(
      'refreshed-access-token-placeholder',
    );
    expect(silentCalls).toBe(2);
  });

  it('lists token status and scopes without exposing tokens while keeping account caches isolated', async () => {
    const store = openStore();
    store.upsertAccount({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      tokenCache: 'first-account-cache',
    });
    store.upsertAccount({
      accountKey: secondAccount.homeAccountId,
      username: secondAccount.username,
      tenant: secondAccount.tenantId,
      tokenCache: 'second-account-cache',
    });
    const configurations: Configuration[] = [];
    const cachedAccounts = [secondAccount, account];
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: (configuration) => {
        const cachedAccount = cachedAccounts[configurations.length]!;
        configurations.push(configuration);
        const client = createFakeClient();
        client.getAllAccounts = async () => [cachedAccount];
        client.acquireTokenSilent = async () =>
          authResult({
            account: cachedAccount,
            accessToken: `${cachedAccount.homeAccountId}-token-placeholder`,
            scopes: cachedAccount.homeAccountId === secondAccount.homeAccountId
              ? ['User.Read']
              : ['Calendars.ReadWrite'],
          });
        return client;
      },
    });

    const accounts = await manager.listAccounts();

    expect(accounts).toEqual([
      {
        accountKey: secondAccount.homeAccountId,
        username: secondAccount.username,
        tenant: secondAccount.tenantId,
        createdAt: 100,
        updatedAt: 100,
        scopes: ['User.Read'],
        tokenStatus: 'valid',
      },
      {
        accountKey: account.homeAccountId,
        username: account.username,
        tenant: account.tenantId,
        createdAt: 100,
        updatedAt: 100,
        scopes: ['Calendars.ReadWrite'],
        tokenStatus: 'valid',
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('token-placeholder');

    const deserializedCaches: string[] = [];
    for (const configuration of configurations) {
      await configuration.cache?.cachePlugin?.beforeCacheAccess({
        tokenCache: {
          deserialize: (cache: string) => {
            deserializedCaches.push(cache);
          },
          serialize: () => '',
        },
        cacheHasChanged: false,
      } as unknown as TokenCacheContext);
    }
    expect(deserializedCaches).toEqual([
      'second-account-cache',
      'first-account-cache',
    ]);

    await configurations[0]?.cache?.cachePlugin?.afterCacheAccess({
      tokenCache: {
        deserialize: () => undefined,
        serialize: () => 'updated-second-account-cache',
      },
      cacheHasChanged: true,
    } as unknown as TokenCacheContext);
    expect(store.getTokenCache(secondAccount.homeAccountId)).toBe(
      'updated-second-account-cache',
    );
    expect(store.getTokenCache(account.homeAccountId)).toBe(
      'first-account-cache',
    );
  });

  it('signs out, removes the encrypted account cache, and clears the memory token', async () => {
    const store = openStore();
    store.upsertAccount({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      tokenCache: 'serialized-msal-cache',
    });
    const signedOut: AccountInfo[] = [];
    let silentCalls = 0;
    const client = createFakeClient();
    client.acquireTokenSilent = async () => {
      silentCalls += 1;
      return authResult();
    };
    client.signOut = async ({ account: signedOutAccount }) => {
      signedOut.push(signedOutAccount);
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
    });
    await manager.getAccessToken(account.homeAccountId);

    await expect(manager.removeAccount(account.homeAccountId)).resolves.toBe(
      true,
    );
    expect(signedOut).toEqual([account]);
    expect(store.getAccount(account.homeAccountId)).toBeNull();

    store.upsertAccount({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      tokenCache: 'replacement-serialized-cache',
    });
    await manager.getAccessToken(account.homeAccountId);
    expect(silentCalls).toBe(2);
  });

  it('maps an MSAL interaction-required failure to a friendly reauth_required error', async () => {
    const store = openStore();
    store.upsertAccount({
      accountKey: account.homeAccountId,
      username: account.username,
      tenant: account.tenantId,
      tokenCache: 'serialized-msal-cache',
    });
    const client = createFakeClient();
    client.acquireTokenSilent = async () => {
      throw new InteractionRequiredAuthError(
        'interaction_required',
        'correlation-id',
        'interaction required',
      );
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
    });

    await expect(
      manager.getAccessToken(account.homeAccountId),
    ).rejects.toMatchObject({
      code: 'reauth_required',
      message:
        'Microsoft calendar authorization expired. Run graph_calendar_connect to reconnect this account.',
    });
  });

  it('falls back to device-code authentication when the system browser cannot open', async () => {
    const store = openStore();
    const deviceMessages: string[] = [];
    const client = createFakeClient();
    client.acquireTokenByDeviceCode = async (request) => {
      request.deviceCodeCallback({
        userCode: 'CODE-PLACEHOLDER',
        deviceCode: 'device-code-placeholder',
        verificationUri: 'https://login.example.test/device',
        expiresIn: 600,
        interval: 5,
        message: 'Use CODE-PLACEHOLDER to connect.',
      });
      return authResult();
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
      openExternal: async () => {
        throw new Error('system browser unavailable');
      },
      deviceCodeCallback: (message) => {
        deviceMessages.push(message);
      },
    });

    await expect(manager.connectAccount()).resolves.toMatchObject({
      accountKey: account.homeAccountId,
      username: account.username,
    });
    expect(deviceMessages).toEqual(['Use CODE-PLACEHOLDER to connect.']);
    expect(store.getTokenCache(account.homeAccountId)).toBe(
      'serialized-msal-cache',
    );
  });

  it('bounds abandoned browser consent and falls back to device-code authentication', async () => {
    const store = openStore();
    let deviceCalls = 0;
    const client = createFakeClient();
    client.acquireTokenByDeviceCode = async () => {
      deviceCalls += 1;
      return authResult();
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
      openExternal: async () => undefined,
      deviceCodeCallback: () => undefined,
      interactiveTimeoutMs: 10,
    });

    await expect(manager.connectAccount()).resolves.toMatchObject({
      accountKey: account.homeAccountId,
    });
    expect(deviceCalls).toBe(1);
  });

  it('keeps callback authority and other untrusted fields out of the token exchange', async () => {
    const store = openStore();
    const client = createFakeClient();
    let request: AuthorizationCodeRequest | undefined;
    let payload: AuthorizationCodePayload | undefined;
    client.acquireTokenByCode = async (value, response) => {
      request = value;
      payload = response;
      return authResult();
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      authority: 'https://login.microsoftonline.com/organizations',
      tokenStore: store,
      createClient: () => client,
      openExternal: (url) => completeAuthorization(url, {
        authority: 'https://attacker.example.test/tenant',
        cloud_instance_host_name: 'attacker.example.test',
        redirectUri: 'https://attacker.example.test/callback',
        scopes: 'unrequested-scope',
        nonce: 'attacker-nonce-placeholder',
      }),
    });

    await expect(manager.connectAccount()).resolves.toMatchObject({ accountKey: account.homeAccountId });
    expect(request?.authority).toBe('https://login.microsoftonline.com/organizations');
    expect(request?.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    expect(request?.scopes).not.toContain('unrequested-scope');
    expect(request?.nonce).not.toBe('attacker-nonce-placeholder');
    expect(payload).toEqual({ code: 'code-placeholder', state: request?.state });
  });

  it('runs the real MSAL public authorization flow against only the configured token endpoint', async () => {
    const store = openStore();
    const realFetch = globalThis.fetch;
    const tokenRequests: { url: URL; options?: RequestInit }[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.protocol === 'http:' && url.hostname === 'localhost') {
        return realFetch(input, options);
      }
      tokenRequests.push({ url, options });
      if (
        url.origin !== 'https://login.example.test'
        || url.pathname !== '/tenant/oauth2/v2.0/token'
        || options?.method !== 'POST'
      ) {
        throw new Error('Unexpected authority metadata or token request');
      }
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Authorization code placeholder rejected.',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const authorityMetadata = JSON.stringify({
      authorization_endpoint: 'https://login.example.test/tenant/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.example.test/tenant/oauth2/v2.0/token',
      issuer: 'https://login.example.test/tenant/v2.0',
      jwks_uri: 'https://login.example.test/keys',
      end_session_endpoint: 'https://login.example.test/logout',
    });
    const openedUrls: URL[] = [];
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      authority: 'https://login.example.test/tenant',
      tokenStore: store,
      createClient: (configuration) => new PublicClientApplication({
        ...configuration,
        auth: { ...configuration.auth, knownAuthorities: ['login.example.test'], authorityMetadata },
      }),
      openExternal: async (url) => {
        openedUrls.push(new URL(url));
        await completeAuthorization(url, {
          authority: 'https://attacker.example.test/tenant',
          cloud_instance_host_name: 'attacker.example.test',
        });
      },
    });

    try {
      await expect(manager.connectAccount()).rejects.toMatchObject({ errorCode: 'invalid_grant' });
      expect(tokenRequests).toHaveLength(1);
      const { url: tokenUrl, options: tokenOptions } = tokenRequests[0]!;
      expect(tokenUrl.origin).toBe('https://login.example.test');
      expect(tokenUrl.pathname).toBe('/tenant/oauth2/v2.0/token');
      expect(openedUrls[0]?.searchParams.get('response_mode')).toBe('form_post');
      expect(typeof tokenOptions?.body).toBe('string');
      const verifier = new URLSearchParams(String(tokenOptions?.body)).get('code_verifier');
      expect(createHash('sha256').update(verifier!).digest('base64url'))
        .toBe(openedUrls[0]?.searchParams.get('code_challenge'));
      expect(store.listAccounts()).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns a consent refusal without silently starting device-code authentication', async () => {
    const store = openStore();
    const client = createFakeClient();
    let tokenCalls = 0;
    let deviceCalls = 0;
    client.acquireTokenByCode = async () => {
      tokenCalls += 1;
      return authResult();
    };
    client.acquireTokenByDeviceCode = async () => {
      deviceCalls += 1;
      return authResult();
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
      openExternal: (url) => completeAuthorization(url, {
        code: '',
        error: 'access_denied',
        error_description: 'Consent was declined.',
      }),
      deviceCodeCallback: () => undefined,
    });

    await expect(manager.connectAccount()).rejects.toMatchObject({ errorCode: 'access_denied' });
    expect(tokenCalls).toBe(0);
    expect(deviceCalls).toBe(0);
    expect(store.listAccounts()).toEqual([]);
  });

  it('does not open a stale browser after URL discovery outlives the consent deadline', async () => {
    const store = openStore();
    const client = createFakeClient();
    const getAuthCodeUrl = client.getAuthCodeUrl;
    let finishDiscovery: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => { finishDiscovery = resolve; });
    client.getAuthCodeUrl = async (request) => {
      await discovery;
      return getAuthCodeUrl(request);
    };
    const openedUrls: string[] = [];
    let tokenCalls = 0;
    client.acquireTokenByCode = async () => {
      tokenCalls += 1;
      return authResult();
    };
    const manager = new GraphAuthManager({
      clientId: 'client-id',
      tokenStore: store,
      createClient: () => client,
      openExternal: async (url) => { openedUrls.push(url); },
      deviceCodeCallback: () => undefined,
      interactiveTimeoutMs: 10,
    });

    await expect(manager.connectAccount()).resolves.toMatchObject({ accountKey: account.homeAccountId });
    finishDiscovery?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(openedUrls).toEqual([]);
    expect(tokenCalls).toBe(0);
  });
});

async function completeAuthorization(url: string, additionalFields: Record<string, string> = {}): Promise<void> {
  const authorization = new URL(url);
  const response = await fetch(authorization.searchParams.get('redirect_uri')!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: 'code-placeholder',
      state: authorization.searchParams.get('state')!,
      ...additionalFields,
    }).toString(),
  });
  await response.arrayBuffer();
}
