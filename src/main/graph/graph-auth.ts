import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  PromptValue,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type DeviceCodeRequest,
  type ICachePlugin,
  type InteractiveRequest,
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
  acquireTokenInteractive(request: InteractiveRequest): Promise<AuthenticationResult>;
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
      result = await client.acquireTokenInteractive({
        scopes: [...this.scopes],
        prompt: PromptValue.SELECT_ACCOUNT,
        loopbackClient: new TimedGraphLoopbackClient(this.interactiveTimeoutMs),
        openBrowser: async (url) => {
          try {
            await this.openExternal(url);
          } catch (error) {
            browserOpenFailed = true;
            throw error;
          }
        },
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
  if (
    browserOpenFailed ||
    error instanceof GraphInteractiveTimeoutError ||
    error instanceof GraphLoopbackUnavailableError
  ) {
    return true;
  }
  const errorCode = typeof error === 'object' && error !== null && 'errorCode' in error
    ? String(error.errorCode)
    : '';
  return new Set([
    'invalid_loopback_server_address_type',
    'unable_to_load_redirectUrl',
    'no_loopback_server_exists',
    'loopback_server_already_exists',
    'loopback_server_timeout',
    'no_auth_code_in_response',
  ]).has(errorCode);
}

async function openExternalWithElectron(url: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require('electron') as {
    shell: { openExternal(target: string): Promise<void> };
  };
  await shell.openExternal(url);
}
