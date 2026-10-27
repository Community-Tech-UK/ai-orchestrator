import { getSettingsManager } from '../core/config/settings-manager';
import { getOperatorDatabase } from '../operator/operator-database';
import { getMcpSecretStorage } from '../mcp/secret-storage';
import { getLogger } from '../logging/logger';
import {
  callGraphConnectorTool,
  listGraphConnectorTools,
  type GraphConnectorDependencies,
} from '../mcp/connector-graph-tools';
import { GraphAuthManager, GraphReauthRequiredError, type GraphAccountStatus } from './graph-auth';
import { GraphClient, type GraphRequestContext } from './graph-client';
import { GraphTokenStore, type GraphAccount } from './graph-token-store';

const MUTATION_TOOLS = new Set([
  'graph_calendar_create_event', 'graph_calendar_update_event', 'graph_calendar_delete_event',
  'graph_mail_create_draft', 'graph_mail_send',
]);

export interface GraphConnectorServiceOptions {
  authManager: Pick<GraphAuthManager, 'connectAccount' | 'listAccounts' | 'removeAccount'>;
  createGraphClient: (context: GraphRequestContext) => NonNullable<GraphConnectorDependencies['graphClient']>;
  writableAccountEmails: () => readonly string[];
  updateWritableAccountEmails: (emails: string[]) => void;
  listStoredAccounts: () => readonly GraphAccount[];
}

export class GraphConnectorService {
  private static instance: GraphConnectorService | null = null;

  static getInstance(): GraphConnectorService {
    if (!this.instance) {
      const settings = getSettingsManager();
      const tokenStore = new GraphTokenStore(getOperatorDatabase().db, getMcpSecretStorage());
      const authManager = new GraphAuthManager({
        clientId: settings.get('graphClientId'),
        authority: settings.get('graphAuthority'),
        scopes: parseStringList(settings.get('graphScopesJson')),
        tokenStore,
        deviceCodeCallback: presentDeviceCode,
      });
      this.instance = new GraphConnectorService({
        authManager,
        createGraphClient: (requestContext) => new GraphClient({ tokenProvider: authManager, requestContext }),
        listStoredAccounts: () => tokenStore.listAccounts(),
        updateWritableAccountEmails: (emails) => settings.set('graphAgentWritableAccountsJson', JSON.stringify(emails)),
        writableAccountEmails: () => {
          // A malformed write policy must fail closed, including while approval is open.
          try { return parseStringList(settings.get('graphAgentWritableAccountsJson')); }
          catch { return []; }
        },
      });
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(private readonly options: GraphConnectorServiceOptions) {}

  connectAccount(mailEnabled = false): Promise<GraphAccount> {
    return this.options.authManager.connectAccount({ mailEnabled });
  }

  listAccounts(): Promise<GraphAccountStatus[]> {
    return this.options.authManager.listAccounts();
  }

  removeAccount(accountKey: string): Promise<boolean> {
    return this.options.authManager.removeAccount(accountKey);
  }

  async isWritable(accountKey: string): Promise<boolean> {
    const account = (await this.storedAccounts()).find((candidate) => candidate.accountKey === accountKey);
    return Boolean(account && this.options.writableAccountEmails()
      .some((email) => email.trim().toLowerCase() === account.username.toLowerCase()));
  }

  async setWritable(accountKey: string, allowed: boolean): Promise<void> {
    const account = (await this.storedAccounts()).find((candidate) => candidate.accountKey === accountKey);
    if (!account) throw new Error('This Microsoft 365 account is not connected. Sign in again in Settings → Connectors.');
    const username = account.username.trim().toLowerCase();
    const emails = this.options.writableAccountEmails().filter((email) => email.trim().toLowerCase() !== username);
    if (allowed) emails.push(account.username);
    this.options.updateWritableAccountEmails(emails);
  }

  listTools(accountKey: string, mailEnabled = false) {
    return listGraphConnectorTools(accountKey, this.dependencies(), mailEnabled);
  }

  async testConnection(accountKey: string, mailEnabled = false): Promise<void> {
    if (!(await this.storedAccounts()).some((account) => account.accountKey === accountKey)) {
      throw new GraphReauthRequiredError();
    }
    const client = this.options.createGraphClient({});
    try {
      await client.listCalendars(accountKey);
      if (mailEnabled) await client.listMailFolders(accountKey);
    } catch (error) {
      if (error instanceof Error && /reauth_required|invalid_grant|interaction_required|login_required|graph_api_error:(401|403)/i.test(error.message)) {
        throw new GraphReauthRequiredError();
      }
      throw error;
    }
  }

  callTool(
    accountKey: string,
    toolName: string,
    args: Record<string, unknown>,
    mailEnabled = false,
    authorizeMutation?: GraphConnectorDependencies['authorizeMutation'],
    requestContext: GraphRequestContext = {},
  ): Promise<unknown> {
    const context: GraphRequestContext = {
      signal: requestContext.signal,
      assertActive: () => {
        requestContext.signal?.throwIfAborted();
        requestContext.assertActive?.();
        if (MUTATION_TOOLS.has(toolName)) {
          const account = this.options.listStoredAccounts().find((candidate) => candidate.accountKey === accountKey);
          if (!account || !this.options.writableAccountEmails().some((email) => email.trim().toLowerCase() === account.username.toLowerCase())) {
            throw new Error('Microsoft 365 changes are not permitted for this account.');
          }
        }
      },
    };
    return callGraphConnectorTool(accountKey, toolName, args, this.dependencies(authorizeMutation, context), mailEnabled);
  }

  private storedAccounts(): Promise<readonly GraphAccount[]> {
    // Account resolution must not refresh unrelated accounts' tokens on every call.
    return Promise.resolve(this.options.listStoredAccounts());
  }

  private dependencies(
    authorizeMutation?: GraphConnectorDependencies['authorizeMutation'],
    requestContext: GraphRequestContext = {},
  ): GraphConnectorDependencies {
    const options = this.options;
    return {
      authManager: {
        connectAccount: () => options.authManager.connectAccount(),
        listAccounts: () => this.storedAccounts(),
      },
      graphClient: options.createGraphClient(requestContext),
      assertActive: requestContext.assertActive,
      get writableAccountEmails() { return options.writableAccountEmails(); },
      authorizeMutation,
    };
  }
}

export function getGraphConnectorService(): GraphConnectorService {
  return GraphConnectorService.getInstance();
}

function parseStringList(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)) {
    throw new Error('Microsoft 365 account settings must contain a list of nonempty values.');
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function presentDeviceCode(message: string): void {
  // The short-lived code belongs in the operator dialog, never in logs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dialog } = require('electron') as {
    dialog: { showMessageBox(options: { type: 'info'; title: string; message: string; detail: string; buttons: string[] }): Promise<unknown> };
  };
  void dialog.showMessageBox({
    type: 'info', title: 'Microsoft 365 sign-in',
    message: 'Complete Microsoft sign-in in another browser or device.', detail: message, buttons: ['OK'],
  }).catch(() => {
    getLogger('GraphConnectorService').warn('Unable to display Microsoft device-code sign-in instructions');
  });
}
