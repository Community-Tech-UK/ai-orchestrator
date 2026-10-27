import { describe, expect, it, vi } from 'vitest';
import { callGraphConnectorTool, listGraphConnectorTools, type GraphConnectorDependencies } from './connector-graph-tools';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';

function dependencies(): GraphConnectorDependencies {
  return {
    authManager: {
      connectAccount: vi.fn(),
      listAccounts: async () => [
        { accountKey: 'work-key', username: 'james@communitytech.co.uk' },
        { accountKey: 'other-key', username: 'other@example.test' },
      ],
    },
    graphClient: {
      listCalendars: vi.fn(async (account) => [{ account }]),
      listEvents: vi.fn(async (account) => [{ account }]),
      createEvent: vi.fn(async (account) => ({ account })),
      updateEvent: vi.fn(async (account) => ({ account })),
      deleteEvent: vi.fn(async () => undefined),
      searchMail: vi.fn(async (account) => [{ account }]),
      readMail: vi.fn(async (account) => ({ account })),
      listMailFolders: vi.fn(async (account) => [{ account }]),
      createMailDraft: vi.fn(async (account) => ({ account })),
      sendMailDraft: vi.fn(async () => undefined),
    },
    writableAccountEmails: ['james@communitytech.co.uk'],
    authorizeMutation: vi.fn(async () => true),
  };
}

const event = {
  subject: 'Planning',
  start: { dateTime: '2026-10-26T09:00:00', timeZone: 'Europe/London' },
  end: { dateTime: '2026-10-26T10:00:00', timeZone: 'Europe/London' },
};
const draft = {
  subject: 'Planning', body: { contentType: 'text', content: 'Agenda' },
  toRecipients: [{ emailAddress: { address: 'recipient@example.test' } }],
};

describe('Microsoft 365 connector tools', () => {
  it('keeps account-specific calendars out of the always-on Harness tool catalog', () => {
    const tools = createOrchestratorToolsForwarderTools({ call: async () => null });
    expect(tools.filter((tool) => tool.name.startsWith('graph_calendar_'))).toEqual([]);
  });

  it('binds every calendar tool to its connector account and omits cross-account controls', async () => {
    const deps = dependencies();
    const tools = listGraphConnectorTools('other-key', deps);
    expect(tools.map((tool) => tool.name)).toEqual([
      'graph_calendar_list_calendars', 'graph_calendar_list_events', 'graph_calendar_create_event',
      'graph_calendar_update_event', 'graph_calendar_delete_event',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema['properties']).not.toHaveProperty('account');
      expect(tool.inputSchema['required']).not.toContain('account');
    }
    await expect(callGraphConnectorTool('other-key', 'graph_calendar_list_calendars', {}, deps))
      .resolves.toEqual([{ account: 'other-key' }]);
    await expect(callGraphConnectorTool('other-key', 'graph_calendar_list_calendars', { account: 'work-key' }, deps))
      .rejects.toThrow(/account.*connector/i);
  });

  it('denies calendar writes for a read-only account before asking for approval', async () => {
    const deps = dependencies();
    await expect(callGraphConnectorTool('other-key', 'graph_calendar_create_event', event, deps)).rejects.toThrow(/not permitted/);
    expect(deps.authorizeMutation).not.toHaveBeenCalled();
    expect(deps.graphClient?.createEvent).not.toHaveBeenCalled();
  });

  it('requires operator approval for calendar writes and fails closed without an approval callback', async () => {
    const deps = dependencies();
    deps.authorizeMutation = vi.fn(async () => false);
    await expect(callGraphConnectorTool('work-key', 'graph_calendar_create_event', event, deps)).rejects.toThrow(/approval/);
    expect(deps.graphClient?.createEvent).not.toHaveBeenCalled();
    delete deps.authorizeMutation;
    await expect(callGraphConnectorTool('work-key', 'graph_calendar_create_event', event, deps)).rejects.toThrow(/approval/);
    deps.authorizeMutation = async () => true;
    await expect(callGraphConnectorTool('work-key', 'graph_calendar_create_event', event, deps)).resolves.toEqual({ account: 'work-key' });
  });

  it('offers mail only when enabled and validates schemas before sending requests', async () => {
    const deps = dependencies();
    await expect(callGraphConnectorTool('work-key', 'graph_mail_read', { messageId: 'message-1' }, deps)).rejects.toThrow(/Unknown/);
    const tools = listGraphConnectorTools('work-key', deps, true);
    expect(tools.filter((tool) => tool.name.startsWith('graph_mail_')).map((tool) => tool.name)).toEqual([
      'graph_mail_search', 'graph_mail_read', 'graph_mail_list_folders', 'graph_mail_create_draft', 'graph_mail_send',
    ]);
    await expect(callGraphConnectorTool('work-key', 'graph_mail_create_draft', { ...draft, account: 'other-key' }, deps, true)).rejects.toThrow();
    await expect(callGraphConnectorTool('work-key', 'graph_mail_create_draft', { ...draft, toRecipients: [{ emailAddress: { address: 'invalid' } }] }, deps, true)).rejects.toThrow();
    expect(deps.graphClient?.createMailDraft).not.toHaveBeenCalled();
  });

  it('reads mail from the bound account and denies drafts and sends on read-only accounts', async () => {
    const deps = dependencies();
    await expect(callGraphConnectorTool('other-key', 'graph_mail_read', { messageId: 'message-1' }, deps, true)).resolves.toEqual({ account: 'other-key' });
    await expect(callGraphConnectorTool('other-key', 'graph_mail_create_draft', draft, deps, true)).rejects.toThrow(/not permitted/);
    await expect(callGraphConnectorTool('other-key', 'graph_mail_send', { messageId: 'draft-1' }, deps, true)).rejects.toThrow(/not permitted/);
    expect(deps.graphClient?.createMailDraft).not.toHaveBeenCalled();
    expect(deps.graphClient?.sendMailDraft).not.toHaveBeenCalled();
    expect(deps.authorizeMutation).not.toHaveBeenCalled();
  });

  it('allows approved drafts/sends and never returns token fields from Graph responses', async () => {
    const deps = dependencies();
    deps.graphClient!.createMailDraft = async () => ({ id: 'draft-1', accessToken: 'placeholder', nested: { authorization: 'placeholder' } });
    await expect(callGraphConnectorTool('work-key', 'graph_mail_create_draft', draft, deps, true))
      .resolves.toEqual({ id: 'draft-1', nested: {} });
    await expect(callGraphConnectorTool('work-key', 'graph_mail_send', { messageId: 'draft-1' }, deps, true))
      .resolves.toEqual({ ok: true });
    expect(deps.graphClient?.sendMailDraft).toHaveBeenCalledWith('work-key', 'draft-1');
    expect(deps.authorizeMutation).toHaveBeenCalledTimes(1);
  });

  it('returns a serializable confirmation after deleting an event with an empty Graph response', async () => {
    await expect(callGraphConnectorTool('work-key', 'graph_calendar_delete_event', { eventId: 'event-1' }, dependencies()))
      .resolves.toEqual({ ok: true });
  });
});
