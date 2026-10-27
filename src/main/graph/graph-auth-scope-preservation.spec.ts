import { afterEach, describe, expect, it } from 'vitest';
import { InteractionRequiredAuthError, type AccountInfo, type AuthenticationResult } from '@azure/msal-node';
import { GraphAuthManager, type GraphPublicClientApplication } from './graph-auth';
import { GraphTokenStore } from './graph-token-store';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { McpSecretStorage } from '../mcp/secret-storage';

const databases: SqliteDriver[] = [];
const account: AccountInfo = { homeAccountId: 'account', username: 'user@example.test', tenantId: 'tenant',
  environment: 'login.example.test', localAccountId: 'local-account' };

function setup() {
  const db = defaultDriverFactory(':memory:');
  databases.push(db);
  const store = new GraphTokenStore(db, new McpSecretStorage({ safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`wrapped:${value}`),
    decryptString: (value) => value.toString().replace(/^wrapped:/, ''),
  } }));
  const requestedScopes: string[][] = [];
  let now = 0;
  let silentExpired = false;
  let selectedAccount = account;
  const result = (scopes: string[]): AuthenticationResult => ({
    authority: 'https://login.example.test/tenant', uniqueId: 'unique', tenantId: selectedAccount.tenantId,
    scopes, account: selectedAccount, idToken: 'ID_TOKEN_PLACEHOLDER', idTokenClaims: {},
    accessToken: scopes.includes('Mail.Send') ? 'MAIL_TOKEN_PLACEHOLDER' : 'CALENDAR_TOKEN_PLACEHOLDER',
    fromCache: false, expiresOn: new Date(1_000_000), tokenType: 'Bearer', correlationId: 'correlation',
  });
  const manager = new GraphAuthManager({
    clientId: 'CLIENT_ID_PLACEHOLDER', tokenStore: store, now: () => now,
    createClient: () => {
      let scopes: string[] = [];
      const client: GraphPublicClientApplication = {
        getAuthCodeUrl: async (request) => {
          scopes = [...request.scopes];
          requestedScopes.push(scopes);
          const url = new URL('https://login.example.test/authorize');
          url.searchParams.set('redirect_uri', request.redirectUri);
          url.searchParams.set('state', request.state!);
          return url.toString();
        },
        acquireTokenByCode: async () => result(scopes),
        acquireTokenByDeviceCode: async () => result(scopes),
        acquireTokenSilent: async (request) => {
          if (silentExpired) throw new InteractionRequiredAuthError('interaction_required', 'correlation', 'Sign-in required');
          return result(request.scopes);
        },
        getAllAccounts: async () => [selectedAccount], signOut: async () => undefined,
        getTokenCache: () => ({ serialize: () => scopes.includes('Mail.Send') ? 'mail-cache-placeholder' : 'calendar-cache-placeholder' }),
      };
      return client;
    },
    openExternal: async (raw) => {
      const url = new URL(raw);
      const response = await fetch(url.searchParams.get('redirect_uri')!, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ state: url.searchParams.get('state')!, code: 'CODE_PLACEHOLDER' }),
      });
      await response.arrayBuffer();
    },
  });
  return { manager, store, requestedScopes,
    expire: () => { now = 1_000_000; silentExpired = true; },
    selectAnotherAccount: () => { selectedAccount = { ...account, homeAccountId: 'other-account', username: 'other@example.test' }; } };
}

describe('shared Microsoft account consent', () => {
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it('preserves the existing mail cache, scopes and memory token when the same account signs in calendar-only', async () => {
    const test = setup();
    await test.manager.connectAccount({ mailEnabled: true });
    await test.manager.connectAccount({ mailEnabled: false });
    expect(test.store.getScopes('account')).toContain('Mail.Send');
    expect(test.store.getTokenCache('account')).toBe('mail-cache-placeholder');
    await expect(test.manager.getAccessToken('account')).resolves.toBe('MAIL_TOKEN_PLACEHOLDER');
    expect(test.requestedScopes[1]).not.toContain('Mail.Send');
  });

  it('keeps an expired broader account expired and asks for mail-enabled sign-in instead of storing a narrower token', async () => {
    const test = setup();
    await test.manager.connectAccount({ mailEnabled: true });
    test.expire();
    await expect(test.manager.connectAccount({ mailEnabled: false })).rejects.toThrow(/mail enabled.*Connectors/);
    expect(test.store.getScopes('account')).toContain('Mail.Send');
    expect(test.store.getTokenCache('account')).toBe('mail-cache-placeholder');
    expect(await test.manager.listAccounts()).toMatchObject([{ tokenStatus: 'reauth_required' }]);
  });

  it('does not request mail consent on a different, new calendar-only account', async () => {
    const test = setup();
    await test.manager.connectAccount({ mailEnabled: true });
    test.selectAnotherAccount();
    await test.manager.connectAccount({ mailEnabled: false });
    expect(test.requestedScopes[1]).not.toContain('Mail.Send');
    expect(test.store.getScopes('other-account')).not.toContain('Mail.Send');
    expect(test.store.getTokenCache('other-account')).toBe('calendar-cache-placeholder');
    expect(test.store.getScopes('account')).toContain('Mail.Send');
  });
});
