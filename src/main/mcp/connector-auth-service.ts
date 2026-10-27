import { getNotificationService } from '../notifications/notification-service';
import { randomBytes } from 'node:crypto';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { ConnectorAuthStatus } from '../../shared/types/mcp-dtos.types';
import type { OrchestratorMcpServer } from '../../shared/types/mcp-orchestrator.types';
import type { OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import { getMcpSecretStorage, type EncryptedSecret, type McpSecretStorage } from './secret-storage';
import { listenConnectorOAuth } from './connector-oauth-loopback';

interface CredentialState {
  binding: string;
  bearer?: string;
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  expiresAt?: number;
  redirectUrl?: string;
}
interface ConnectorAuthDependencies {
  db: SqliteDriver;
  secrets: McpSecretStorage;
  repo: OrchestratorMcpRepository;
  openBrowser(url: string): Promise<void>;
  fetch?: typeof fetch;
  onSignInRequired?(name: string): void;
}
export class ConnectorAuthService {
  private readonly refreshing = new Map<string, Promise<string | undefined>>();
  private readonly signingIn = new Set<string>();
  private readonly versions = new Map<string, number>();
  private readonly notices = new Set<string>();
  constructor(private readonly deps: ConnectorAuthDependencies) {}

  status(id: string): ConnectorAuthStatus {
    const record = this.requireRecord(id);
    if (!record.authType || record.authType === 'none' || record.kind === 'microsoft365')
      return { state: 'not-required' };
    const state = this.read(record);
    if (!state?.bearer && !state?.tokens) return { state: 'signed-out' };
    if (this.notices.has(id)) return { state: 'expired' };
    return {
      state:
        state.expiresAt && state.expiresAt <= Date.now() && !state.tokens?.refresh_token
          ? 'expired'
          : 'signed-in',
    };
  }
  setBearerToken(id: string, token: string): void {
    const record = this.requireRecord(id);
    if (record.authType !== 'bearer' || !record.url)
      throw new Error('Choose API key sign-in for this remote connector first.');
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('Enter an API key or bearer token.');
    this.bump(id);
    this.write(id, { binding: this.binding(record), bearer: token });
    this.notices.delete(id);
  }
  signOut(id: string): void {
    this.bump(id);
    this.deps.db.prepare('DELETE FROM connector_auth WHERE connector_id = ?').run(id);
    this.notices.delete(id);
  }
  async signIn(id: string): Promise<void> {
    if (this.signingIn.has(id))
      throw new Error('Sign-in is already in progress for this connector.');
    const record = this.requireRecord(id);
    if (record.authType !== 'oauth' || !record.url)
      throw new Error('Choose browser sign-in for this remote connector first.');
    this.signingIn.add(id);
    const version = this.bump(id);
    const stateValue = randomBytes(32).toString('base64url');
    const loopback = await listenConnectorOAuth(stateValue).catch((error) => {
      this.signingIn.delete(id);
      throw error;
    });
    const state: CredentialState = {
      binding: this.binding(record),
      redirectUrl: loopback.redirectUrl,
    };
    const save = () => {
      this.assertCurrent(record, version);
      this.write(id, state);
    };
    let verifier = '';
    const provider: OAuthClientProvider = {
      redirectUrl: loopback.redirectUrl,
      clientMetadataUrl: record.clientMetadataUrl,
      clientMetadata: {
        client_name: 'Harness',
        redirect_uris: [loopback.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      state: () => stateValue,
      clientInformation: () => state.client,
      saveClientInformation: (client) => {
        state.client = client;
        save();
      },
      tokens: () => state.tokens,
      saveTokens: (tokens) => {
        state.tokens = tokens;
        state.expiresAt =
          tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
        save();
      },
      discoveryState: () => state.discovery,
      saveDiscoveryState: (discovery) => {
        state.discovery = discovery;
        save();
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      redirectToAuthorization: (url) => this.deps.openBrowser(url.toString()),
    };
    try {
      const started = await auth(provider, {
        serverUrl: record.url,
        fetchFn: this.fetchWithTimeout,
      });
      if (started === 'REDIRECT') {
        const params = await loopback.result;
        if (params.has('error'))
          throw new Error('Connector sign-in was declined. Try signing in again.');
        const issuer = params.get('iss');
        if (
          issuer &&
          issuer.replace(/\/$/, '') !== state.discovery?.authorizationServerUrl.replace(/\/$/, '')
        )
          throw new Error('Connector sign-in came from an unexpected service.');
        await auth(provider, {
          serverUrl: record.url,
          authorizationCode: params.get('code')!,
          fetchFn: this.fetchWithTimeout,
        });
      }
      this.assertCurrent(record, version);
      if (!state.tokens) throw new Error('Connector sign-in did not return an access token.');
      this.notices.delete(id);
    } catch {
      throw new Error(
        `Could not sign in to ${record.name}. Check the connector address and try again.`,
      );
    } finally {
      loopback.close();
      this.signingIn.delete(id);
    }
  }
  async getAccessToken(id: string, forceRefresh = false): Promise<string | undefined> {
    const record = this.requireRecord(id);
    if (!record.authType || record.authType === 'none') return undefined;
    const state = this.read(record);
    if (this.notices.has(id)) throw this.signInRequired(record);
    if (record.authType === 'bearer' && state?.bearer) {
      if (forceRefresh) throw this.signInRequired(record);
      return state.bearer;
    }
    if (record.authType !== 'oauth' || !state?.tokens) throw this.signInRequired(record);
    if (!forceRefresh && (!state.expiresAt || state.expiresAt > Date.now() + 60_000))
      return state.tokens.access_token;
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const refresh = this.refresh(record, state).finally(() => {
      this.refreshing.delete(id);
    });
    this.refreshing.set(id, refresh);
    return refresh;
  }
  private async refresh(record: OrchestratorMcpServer, state: CredentialState): Promise<string> {
    if (!state.tokens?.refresh_token || !state.client || !state.discovery || !record.url)
      throw this.signInRequired(record);
    const version = this.versions.get(record.id) ?? 0;
    const provider: OAuthClientProvider = {
      redirectUrl: state.redirectUrl,
      clientMetadata: { redirect_uris: state.redirectUrl ? [state.redirectUrl] : [] },
      clientInformation: () => state.client,
      tokens: () => state.tokens,
      discoveryState: () => state.discovery,
      saveTokens: (tokens) => {
        this.assertCurrent(record, version);
        state.tokens = tokens;
        state.expiresAt =
          tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
        this.write(record.id, state);
      },
      codeVerifier: () => {
        throw new Error('Connector sign-in is required.');
      },
      saveCodeVerifier: () => {
        throw new Error('Connector sign-in is required.');
      },
      redirectToAuthorization: () => {
        throw new Error('Connector sign-in is required.');
      },
    };
    try {
      await auth(provider, { serverUrl: record.url, fetchFn: this.fetchWithTimeout });
      this.assertCurrent(record, version);
      return state.tokens!.access_token;
    } catch {
      // An obsolete refresh must not mark a newer sign-in as expired.
      this.assertCurrent(record, version);
      throw this.signInRequired(record);
    }
  }
  async testConnector(id: string): Promise<{ tools: number }> {
    const { listConnectorTools } = await import('./connector-health');
    const record = this.requireRecord(id);
    try {
      return { tools: (await listConnectorTools(record, this)).length };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`Sign in to ${record.name} again`))
        throw error;
      throw new Error(
        `Could not connect to ${record.name}. Check the address and sign-in, then try again.`,
      );
    }
  }
  private readonly fetchWithTimeout: typeof fetch = (input, init) => {
    const deadline = AbortSignal.timeout(30_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return (this.deps.fetch ?? fetch)(input, { ...init, signal });
  };
  private signInRequired(record: OrchestratorMcpServer): Error {
    if (!this.notices.has(record.id)) {
      this.notices.add(record.id);
      this.deps.onSignInRequired?.(record.name);
    }
    return new Error(`Sign in to ${record.name} again in Settings → Connectors`);
  }
  private binding(record: OrchestratorMcpServer): string {
    return JSON.stringify([record.url, record.authType, record.clientMetadataUrl]);
  }
  private requireRecord(id: string): OrchestratorMcpServer {
    const record = this.deps.repo.get(id)?.record;
    if (!record) throw new Error('Connector no longer exists.');
    return record;
  }
  private read(record: OrchestratorMcpServer): CredentialState | undefined {
    const row = this.deps.db
      .prepare('SELECT encrypted_json FROM connector_auth WHERE connector_id = ?')
      .get<{ encrypted_json: string }>(record.id);
    if (!row) return undefined;
    const state = JSON.parse(
      this.deps.secrets.decryptSecret(JSON.parse(row.encrypted_json) as EncryptedSecret),
    ) as CredentialState;
    return state.binding === this.binding(record) ? state : undefined;
  }
  private write(id: string, state: CredentialState): void {
    const encrypted = this.deps.secrets.encryptSecret(JSON.stringify(state));
    this.deps.db
      .prepare(
        'INSERT INTO connector_auth(connector_id,encrypted_json) VALUES (?,?) ON CONFLICT(connector_id) DO UPDATE SET encrypted_json=excluded.encrypted_json',
      )
      .run(id, JSON.stringify(encrypted));
  }
  private bump(id: string): number {
    const next = (this.versions.get(id) ?? 0) + 1;
    this.versions.set(id, next);
    return next;
  }
  private assertCurrent(record: OrchestratorMcpServer, version: number): void {
    if (
      (this.versions.get(record.id) ?? 0) !== version ||
      this.binding(this.requireRecord(record.id)) !== this.binding(record)
    )
      throw new Error('Connector changed while signing in. Try again.');
  }
}
let instance: ConnectorAuthService | null = null;
export function getConnectorAuthService(): ConnectorAuthService {
  if (!instance) {
    // Resolve application singletons only when used; tests construct the service with explicit dependencies.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRLMDatabase } =
      require('../persistence/rlm-database') as typeof import('../persistence/rlm-database');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getOrchestratorMcpRepository } =
      require('./mcp-multi-provider-singletons') as typeof import('./mcp-multi-provider-singletons');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    instance = new ConnectorAuthService({
      db: getRLMDatabase().getRawDb(),
      secrets: getMcpSecretStorage(),
      repo: getOrchestratorMcpRepository(),
      openBrowser: (url) => shell.openExternal(url),
      onSignInRequired: (name) => {
        getNotificationService().notify({
          kind: 'connector-sign-in',
          title: 'Connector needs sign-in',
          body: `Sign in to ${name} again in Settings → Connectors`,
          fingerprintFields: { name },
        });
      },
    });
  }
  return instance;
}
export function _resetConnectorAuthServiceForTesting(): void {
  instance = null;
}
