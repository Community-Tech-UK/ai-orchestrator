import { describe, expect, it, vi } from 'vitest';
import { GraphConnectorService } from './graph-connector-service';
import type { GraphConnectorDependencies } from '../mcp/connector-graph-tools';
import { GraphClient } from './graph-client';

function setup() {
  let permitted = ['james@communitytech.co.uk'];
  let alwaysAllowed: Record<string, string[]> = {};
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
    updateWritableAccountEmails: (emails) => { permitted = emails; },
    alwaysAllowedChanges: () => alwaysAllowed,
    updateAlwaysAllowedChanges: (changes) => { alwaysAllowed = changes; } });
  return { service, authManager, graphClient, revokeWrites: () => { permitted = []; }, alwaysAllowed: () => alwaysAllowed };
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
      alwaysAllowedChanges: () => ({}), updateAlwaysAllowedChanges: vi.fn(),
      createGraphClient: (requestContext) => new GraphClient({
        tokenProvider: { getAccessToken: async () => { permitted = []; return 'TOKEN_PLACEHOLDER'; } },
        fetch, requestContext,
      }),
    });
    await expect(service.callTool('account', 'graph_mail_send', { messageId: 'draft-placeholder' }, true, async () => true))
      .rejects.toThrow(/not permitted/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('remembers "Always allow" per account email and change, and forgets it on request', () => {
    const { service, alwaysAllowed } = setup();
    expect(service.isAlwaysAllowed('work-key', 'graph_mail_send')).toBe(false);
    service.allowAlways('work-key', 'graph_mail_send');
    service.allowAlways('work-key', 'graph_mail_send');
    expect(alwaysAllowed()).toEqual({ 'james@communitytech.co.uk': ['graph_mail_send'] });
    expect(service.isAlwaysAllowed('work-key', 'graph_mail_send')).toBe(true);
    expect(service.isAlwaysAllowed('work-key', 'graph_calendar_delete_event')).toBe(false);
    expect(service.listAlwaysAllowed('work-key')).toEqual(['graph_mail_send']);
    service.forgetAlwaysAllowed('work-key');
    expect(alwaysAllowed()).toEqual({});
    expect(service.isAlwaysAllowed('work-key', 'graph_mail_send')).toBe(false);
  });

  it('refuses to remember a read, or a change on an account that is not connected', () => {
    const { service } = setup();
    expect(() => service.allowAlways('work-key', 'graph_mail_read')).toThrow(/Not a Microsoft 365 change/);
    expect(() => service.allowAlways('unknown', 'graph_mail_send')).toThrow(/not connected/);
    expect(service.isAlwaysAllowed('unknown', 'graph_mail_send')).toBe(false);
  });

  it('still refuses an always-allowed change once agents may no longer write to the account', async () => {
    const { service, graphClient, revokeWrites } = setup();
    service.allowAlways('work-key', 'graph_mail_send');
    revokeWrites();
    await expect(service.callTool('work-key', 'graph_mail_send', { messageId: 'draft-1' }, true, async () => true))
      .rejects.toThrow(/not permitted/);
    expect(graphClient.sendMailDraft).not.toHaveBeenCalled();
  });
});
