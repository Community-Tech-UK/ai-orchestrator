import {
  CryptoProvider,
  InteractionRequiredAuthError,
  PublicClientApplication,
  PromptValue,
  ResponseMode,
  ServerError,
  type AccountInfo,
  type AuthenticationResult,
  type AuthorizationCodePayload,
  type AuthorizationCodeRequest,
  type AuthorizationUrlRequest,
  type Configuration,
  type DeviceCodeRequest,
  type ICachePlugin,
  type SilentFlowRequest,
} from '@azure/msal-node';
import type { GraphAccount, GraphTokenStore } from './graph-token-store';
import {
  GraphInteractiveTimeoutError,
  GraphLoopbackUnavailableError,
  TimedGraphLoopbackClient,
} from './graph-loopback-client';

const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com/common';
const DEFAULT_SCOPES = [
  'Calendars.ReadWrite',
  'offline_access',
  'openid',
  'profile',
  'User.Read',
] as const;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 120_000;
const INTERACTIVE_AUTH_TIMEOUT_MS = 5 * 60_000;

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

interface GraphSerializableTokenCache {
  serialize(): string;
}

export interface GraphPublicClientApplication {
  getAuthCodeUrl(request: AuthorizationUrlRequest): Promise<string>;
  acquireTokenByCode(
    request: AuthorizationCodeRequest,
    response: AuthorizationCodePayload,
  ): Promise<AuthenticationResult>;
  acquireTokenByDeviceCode(
    request: DeviceCodeRequest,
  ): Promise<AuthenticationResult | null>;
  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult>;
  getAllAccounts(): Promise<AccountInfo[]>;
  signOut(request: { account: AccountInfo; correlationId?: string }): Promise<void>;
  getTokenCache(): GraphSerializableTokenCache;
}

export interface GraphAuthManagerOptions {
  clientId: string;
  tokenStore: GraphTokenStore;
  authority?: string;
  scopes?: readonly string[];
  createClient?: (configuration: Configuration) => GraphPublicClientApplication;
  openExternal?: (url: string) => Promise<void>;
  deviceCodeCallback?: (message: string) => void;
  interactiveTimeoutMs?: number;
  now?: () => number;
}

export interface GraphAccountStatus extends GraphAccount {
  scopes: string[];
  tokenStatus: 'valid' | 'reauth_required';
}

export class GraphReauthRequiredError extends Error {
  readonly code = 'reauth_required';

  constructor() {
    super(
      'Microsoft calendar authorization expired. Run graph_calendar_connect to reconnect this account.',
    );
    this.name = 'GraphReauthRequiredError';
  }
}

export class GraphAuthManager {
  private readonly authority: string;
  private readonly scopes: string[];
  private readonly createClient: (
    configuration: Configuration,
  ) => GraphPublicClientApplication;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly interactiveTimeoutMs: number;
  private readonly accessTokens = new Map<string, CachedAccessToken>();

  constructor(private readonly options: GraphAuthManagerOptions) {
    this.authority = options.authority ?? DEFAULT_AUTHORITY;
    this.scopes = [...(options.scopes ?? DEFAULT_SCOPES)];
    this.createClient =
      options.createClient ??
      ((configuration) => new PublicClientApplication(configuration));
    this.openExternal = options.openExternal ?? openExternalWithElectron;
    this.now = options.now ?? Date.now;
    this.interactiveTimeoutMs = options.interactiveTimeoutMs ?? INTERACTIVE_AUTH_TIMEOUT_MS;
  }

  async connectAccount(): Promise<GraphAccount> {
    const client = this.createPublicClient();
    let browserOpenFailed = false;
    let result: AuthenticationResult | null;
    try {
      result = await this.acquireInteractiveToken(client, async (url) => {
        try {
          await this.openExternal(url);
        } catch (error) {
          browserOpenFailed = true;
          throw error;
        }
      });
    } catch (error) {
      if (!shouldUseDeviceCode(error, browserOpenFailed)) {
        throw error;
      }
      const deviceCodeCallback = this.options.deviceCodeCallback;
      if (!deviceCodeCallback) {
        throw new Error(
          'GRAPH_DEVICE_CODE_CALLBACK_REQUIRED: system browser unavailable and no device-code presenter configured',
        );
      }
      result = await client.acquireTokenByDeviceCode({
        scopes: [...this.scopes],
        deviceCodeCallback: ({ message }) => {
          deviceCodeCallback(message);
        },
      });
    }
    if (!result?.account) {
      throw new Error('GRAPH_AUTH_NO_ACCOUNT: Microsoft sign-in returned no account');
    }
    this.cacheAuthenticationResult(result.account.homeAccountId, result);
    return this.options.tokenStore.upsertAccount({
      accountKey: result.account.homeAccountId,
      username: result.account.username,
      tenant: result.account.tenantId,
      tokenCache: client.getTokenCache().serialize(),
    });
  }

  private async acquireInteractiveToken(
    client: GraphPublicClientApplication,
    openBrowser: (url: string) => Promise<void>,
  ): Promise<AuthenticationResult> {
    const crypto = new CryptoProvider();
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const state = crypto.createNewGuid();
    const nonce = crypto.createNewGuid();
    const correlationId = crypto.createNewGuid();
    const loopback = new TimedGraphLoopbackClient(this.interactiveTimeoutMs, state);
    const { redirectUri, response } = await loopback.listenForAuthCode(async (redirectUri) => {
      const url = await client.getAuthCodeUrl({
        scopes: [...this.scopes],
        authority: this.authority,
        redirectUri,
        prompt: PromptValue.SELECT_ACCOUNT,
        responseMode: ResponseMode.FORM_POST,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state,
        nonce,
        correlationId,
      });
      // URL discovery can outlive the consent deadline. Do not open a browser
      // later if this attempt has already closed and started device-code fallback.
      loopback.getRedirectUri();
      await openBrowser(url);
    });
    if (response.error) {
      throw new ServerError(response.error, correlationId, response.error_description, response.suberror);
    }
    if (!response.code) {
      throw new Error('GRAPH_AUTH_NO_CODE: Microsoft sign-in returned no authorization code');
    }

    // Keep configuration separate from untrusted callback data. MSAL validates
    // the returned state against the request and the ID-token nonce against nonce.
    return client.acquireTokenByCode({
      scopes: [...this.scopes],
      authority: this.authority,
      redirectUri,
      code: response.code,
      codeVerifier: verifier,
      clientInfo: response.client_info ?? '',
      state,
      nonce,
      correlationId,
    }, {
      code: response.code,
      state: response.state,
      ...(response.client_info ? { client_info: response.client_info } : {}),
    });
  }

  async getAccessToken(accountKey: string): Promise<string> {
    if (!this.options.tokenStore.getAccount(accountKey)) {
      throw new GraphReauthRequiredError();
    }
    const cached = this.accessTokens.get(accountKey);
    if (cached && cached.expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS > this.now()) {
      return cached.accessToken;
    }
    const client = this.createPublicClient(accountKey);
    const accounts = await client.getAllAccounts();
    const account = accounts.find((candidate) => candidate.homeAccountId === accountKey);
    if (!account) {
      throw new GraphReauthRequiredError();
    }
    let result: AuthenticationResult;
    try {
      result = await client.acquireTokenSilent({
        account,
        scopes: [...this.scopes],
      });
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        throw new GraphReauthRequiredError();
      }
      throw error;
    }
    if (!result.accessToken) {
      throw new GraphReauthRequiredError();
    }
    this.cacheAuthenticationResult(accountKey, result);
    return result.accessToken;
  }

  async listAccounts(): Promise<GraphAccountStatus[]> {
    const accounts = this.options.tokenStore.listAccounts();
    const statuses: GraphAccountStatus[] = [];
    for (const account of accounts) {
      let tokenStatus: GraphAccountStatus['tokenStatus'] = 'valid';
      try {
        await this.getAccessToken(account.accountKey);
      } catch {
        tokenStatus = 'reauth_required';
      }
      statuses.push({
        ...account,
        scopes: [...(this.accessTokens.get(account.accountKey)?.scopes ?? [])],
        tokenStatus,
      });
    }
    return statuses;
  }

  async removeAccount(accountKey: string): Promise<boolean> {
    if (!this.options.tokenStore.getAccount(accountKey)) {
      return false;
    }
    const client = this.createPublicClient(accountKey);
    const accounts = await client.getAllAccounts();
    const account = accounts.find((candidate) => candidate.homeAccountId === accountKey);
    if (account) {
      await client.signOut({ account });
    }
    this.accessTokens.delete(accountKey);
    return this.options.tokenStore.removeAccount(accountKey);
  }

  private cacheAuthenticationResult(
    accountKey: string,
    result: AuthenticationResult,
  ): void {
    if (!result.accessToken) return;
    this.accessTokens.set(accountKey, {
      accessToken: result.accessToken,
      expiresAt: result.expiresOn?.getTime() ?? this.now(),
      scopes: [...result.scopes],
    });
  }

  private createPublicClient(accountKey?: string): GraphPublicClientApplication {
    return this.createClient({
      auth: {
        clientId: this.options.clientId,
        authority: this.authority,
      },
      ...(accountKey
        ? { cache: { cachePlugin: this.createCachePlugin(accountKey) } }
        : {}),
    });
  }

  private createCachePlugin(accountKey: string): ICachePlugin {
    return {
      beforeCacheAccess: async (context) => {
        const serialized = this.options.tokenStore.getTokenCache(accountKey);
        if (serialized) {
          context.tokenCache.deserialize(serialized);
        }
      },
      afterCacheAccess: async (context) => {
        if (
          context.cacheHasChanged &&
          !this.options.tokenStore.updateTokenCache(
            accountKey,
            context.tokenCache.serialize(),
          )
        ) {
          throw new GraphReauthRequiredError();
        }
      },
    };
  }
}

function shouldUseDeviceCode(error: unknown, browserOpenFailed: boolean): boolean {
  return browserOpenFailed
    || error instanceof GraphInteractiveTimeoutError
    || error instanceof GraphLoopbackUnavailableError;
}

async function openExternalWithElectron(url: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require('electron') as {
    shell: { openExternal(target: string): Promise<void> };
  };
  await shell.openExternal(url);
}
