import { describe, expect, it, vi } from 'vitest';
import { buildConnectorMutationApproval, dispatchConnectorRpc } from './connector-rpc';
import { ConnectorAccessRegistry } from './connector-access';

describe('connector RPC authorization', () => {
  it('denies token access to a different session before reading credentials', async () => {
    const access = new ConnectorAccessRegistry();
    access.grant('allowed', ['connector']);
    const getAccessToken = vi.fn(async () => 'PLACEHOLDER_ACCESS');
    const deps = {
      access,
      repo: {
        list: () => [
          {
            record: {
              id: 'connector',
              name: 'example',
              url: 'https://example.test/mcp',
              kind: 'remote' as const,
              autoConnect: true,
            },
          },
        ],
      },
      auth: { getAccessToken },
    };
    await expect(
      dispatchConnectorRpc('connectors.connection', 'other', { name: 'example' }, deps),
    ).rejects.toThrow('not given');
    expect(getAccessToken).not.toHaveBeenCalled();
    await expect(
      dispatchConnectorRpc('connectors.connection', 'allowed', { name: 'example' }, deps),
    ).resolves.toMatchObject({ accessToken: 'PLACEHOLDER_ACCESS' });
  });
  it('refuses a disabled connector even when it was granted at spawn', async () => {
    const access = new ConnectorAccessRegistry();
    access.grant('allowed', ['connector']);
    const deps = {
      access,
      repo: {
        list: () => [
          {
            record: {
              id: 'connector',
              name: 'example',
              kind: 'remote' as const,
              autoConnect: false,
            },
          },
        ],
      },
      auth: { getAccessToken: vi.fn() },
    };
    await expect(
      dispatchConnectorRpc('connectors.connection', 'allowed', { name: 'example' }, deps),
    ).rejects.toThrow('turned off');
  });
});

describe('Microsoft 365 connector tool calls', () => {
  it('accepts the _meta field MCP clients add to a call, without passing it to the tool', async () => {
    const access = new ConnectorAccessRegistry();
    access.grant('session', ['connector']);
    const callTool = vi.fn(async () => ({ folders: [] }));
    const deps = {
      access,
      repo: {
        list: () => [
          {
            record: {
              id: 'connector',
              name: 'm365-example',
              kind: 'microsoft365' as const,
              accountId: 'account',
              autoConnect: true,
              mailEnabled: true,
            },
          },
        ],
      },
      auth: { getAccessToken: vi.fn() },
      graph: { listTools: () => [], callTool },
    };
    await expect(
      dispatchConnectorRpc(
        'connectors.graph',
        'session',
        {
          name: 'm365-example',
          method: 'tools/call',
          params: {
            name: 'graph_mail_list_folders',
            arguments: { folderId: 'inbox' },
            _meta: { progressToken: 1 },
          },
        },
        deps,
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: '{"folders":[]}' }] });
    expect(callTool).toHaveBeenCalledWith(
      'account',
      'graph_mail_list_folders',
      { folderId: 'inbox' },
      true,
      expect.any(Function),
      expect.anything(),
    );
  });
});

describe('Microsoft 365 connector approvals', () => {
  it('names the connector and warns of attendee notifications without copying private message bodies', () => {
    const approval = buildConnectorMutationApproval(
      'm365-example',
      'account',
      'graph_calendar_create_event',
      {
        subject: 'Meeting',
        body: { content: 'PRIVATE_BODY_PLACEHOLDER' },
        attendees: [{ emailAddress: { address: 'example@example.test' } }],
      },
    );
    expect(approval.description).toContain('m365-example');
    expect(approval.description).toContain('attendee invitations');
    expect(JSON.stringify(approval)).not.toContain('PRIVATE_BODY_PLACEHOLDER');
  });
});
