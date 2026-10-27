import { afterEach, describe, expect, it, vi } from 'vitest';
import { listConnectorTools } from './connector-health';
import { GraphConnectorService } from '../graph/graph-connector-service';
import { GraphClient } from '../graph/graph-client';
import { GraphReauthRequiredError } from '../graph/graph-auth';
import type { OrchestratorMcpServer } from '../../shared/types/mcp-orchestrator.types';

const record: OrchestratorMcpServer = {
  id: 'connector', name: 'm365-example', kind: 'microsoft365', accountId: 'account',
  scope: 'orchestrator', transport: 'stdio', autoConnect: true, createdAt: 1, updatedAt: 1,
  mailEnabled: true,
};

function setup(options: { connected?: boolean; expired?: boolean } = {}) {
  const accounts = options.connected === false ? [] : [{
    accountKey: 'account', username: 'user@example.test', tenant: 'tenant', createdAt: 1, updatedAt: 1,
    scopes: [], tokenStatus: 'valid' as const,
  }];
  const getAccessToken = vi.fn(async () => {
    if (options.expired) throw new GraphReauthRequiredError();
    return 'TOKEN_PLACEHOLDER';
  });
  const requests: { url: string; init?: RequestInit }[] = [];
  const service = new GraphConnectorService({
    authManager: { connectAccount: vi.fn(), listAccounts: async () => accounts, removeAccount: vi.fn() },
    writableAccountEmails: () => [], updateWritableAccountEmails: vi.fn(),
    listStoredAccounts: () => accounts,
    createGraphClient: (requestContext) => new GraphClient({
      tokenProvider: { getAccessToken }, requestContext,
      fetch: async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ value: [] }); },
    }),
  });
  vi.spyOn(GraphConnectorService, 'getInstance').mockReturnValue(service);
  return { getAccessToken, requests };
}

describe('Microsoft 365 connector health', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('rejects a signed-out account rather than reporting the static tool catalog as ready', async () => {
    const test = setup({ connected: false });
    await expect(listConnectorTools(record, { getAccessToken: vi.fn() })).rejects.toThrow('Sign in to m365-example again in Settings → Connectors.');
    expect(test.requests).toEqual([]);
  });

  it('rejects expired authorization with a safe sign-in instruction', async () => {
    const test = setup({ expired: true });
    await expect(listConnectorTools(record, { getAccessToken: vi.fn() })).rejects.toThrow('Sign in to m365-example again in Settings → Connectors.');
    expect(test.getAccessToken).toHaveBeenCalledWith('account');
    expect(test.requests).toEqual([]);
  });

  it('checks actual calendar and enabled mail access using authenticated read-only requests', async () => {
    const test = setup();
    const tools = await listConnectorTools(record, { getAccessToken: vi.fn() });
    expect(tools).toHaveLength(10);
    expect(test.requests.map(({ url, init }) => [init?.method, url])).toEqual([
      ['GET', 'https://graph.microsoft.com/v1.0/me/calendars'],
      ['GET', 'https://graph.microsoft.com/v1.0/me/mailFolders'],
    ]);
    expect(test.requests.every(({ init }) => (init?.headers as Record<string, string>)['authorization'] === 'Bearer TOKEN_PLACEHOLDER')).toBe(true);
  });
});
