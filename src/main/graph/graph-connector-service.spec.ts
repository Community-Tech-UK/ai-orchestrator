import { describe, expect, it, vi } from 'vitest';
import { GraphConnectorService } from './graph-connector-service';
import type { GraphConnectorDependencies } from '../mcp/connector-graph-tools';
import { GraphClient } from './graph-client';

function setup() {
  let permitted = ['james@communitytech.co.uk'];
  const accounts = [{ accountKey: 'work-key', username: 'james@communitytech.co.uk', tenant: 'tenant', createdAt: 1, updatedAt: 1, scopes: ['Calendars.ReadWrite'], tokenStatus: 'valid' as const }];
  const authManager = {
    connectAccount: vi.fn(async () => accounts[0]),
    listAccounts: vi.fn(async () => accounts),
    removeAccount: vi.fn(async () => true),
  };
  const graphClient: NonNullable<GraphConnectorDependencies['graphClient']> = {
    listCalendars: async () => [], listEvents: async () => [],
    createEvent: vi.fn(async () => ({ id: 'event-1' })), updateEvent: async () => ({}), deleteEvent: async () => undefined,
    searchMail: async () => [], readMail: async () => ({}), listMailFolders: async () => [],
    createMailDraft: async () => ({}), sendMailDraft: vi.fn(async () => undefined),
  };
  const service = new GraphConnectorService({ authManager, createGraphClient: () => graphClient, writableAccountEmails: () => permitted,
    listStoredAccounts: () => accounts,
    updateWritableAccountEmails: (emails) => { permitted = emails; } });
  return { service, authManager, graphClient, revokeWrites: () => { permitted = []; } };
}

describe('GraphConnectorService', () => {
  it('passes the mail consent choice to Graph auth and exposes account status', async () => {
    const { service, authManager } = setup();
    await service.connectAccount(true);
    expect(authManager.connectAccount).toHaveBeenCalledWith({ mailEnabled: true });
    expect(await service.listAccounts()).toEqual(await authManager.listAccounts());
    expect(await service.isWritable('work-key')).toBe(true);
    expect(await service.isWritable('unknown')).toBe(false);
  });

  it('uses the current writable policy and rechecks it after operator approval', async () => {
    const { service, graphClient, revokeWrites } = setup();
    await expect(service.callTool('work-key', 'graph_mail_send', { messageId: 'draft-1' }, true, async () => {
      revokeWrites();
      return true;
    })).rejects.toThrow(/not permitted/);
    expect(graphClient.sendMailDraft).not.toHaveBeenCalled();
    expect(await service.isWritable('work-key')).toBe(false);
  });

  it('adds and removes only the selected connected account from the existing write policy', async () => {
    const { service, revokeWrites } = setup();
    revokeWrites();
    await service.setWritable('work-key', true);
    expect(await service.isWritable('work-key')).toBe(true);
    await service.setWritable('work-key', false);
    expect(await service.isWritable('work-key')).toBe(false);
    await expect(service.setWritable('unknown', true)).rejects.toThrow(/not connected/);
  });

  it('refuses writes when the writable-account policy changes during token retrieval', async () => {
    const accounts = [{ accountKey: 'account', username: 'user@example.test', tenant: 'tenant', createdAt: 1, updatedAt: 1 }];
    let permitted = ['user@example.test'];
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const service = new GraphConnectorService({
      authManager: { connectAccount: vi.fn(), listAccounts: vi.fn(), removeAccount: vi.fn() },
      listStoredAccounts: () => accounts,
      writableAccountEmails: () => permitted, updateWritableAccountEmails: vi.fn(),
      createGraphClient: (requestContext) => new GraphClient({
        tokenProvider: { getAccessToken: async () => { permitted = []; return 'TOKEN_PLACEHOLDER'; } },
        fetch, requestContext,
      }),
    });
    await expect(service.callTool('account', 'graph_mail_send', { messageId: 'draft-placeholder' }, true, async () => true))
      .rejects.toThrow(/not permitted/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
