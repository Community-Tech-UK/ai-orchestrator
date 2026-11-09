import { describe, expect, it, vi } from 'vitest';
import { authorizeConnectorMutation, buildConnectorMutationApproval, dispatchConnectorRpc } from './connector-rpc';
import type { PermissionDecision, PermissionRequest } from '../../shared/types/permission-registry.types';
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

describe('Microsoft 365 "Always allow"', () => {
  const request = { accountKey: 'account', toolName: 'graph_mail_send', args: { messageId: 'draft' }, connectorName: 'm365-example' };
  function setup(decision: Partial<PermissionDecision>, alreadyAllowed = false) {
    const asked: PermissionRequest[] = [];
    const waiting: PermissionRequest[] = [];
    const registry = {
      requestPermission: vi.fn(async (permission: PermissionRequest): Promise<PermissionDecision> => {
        asked.push(permission);
        return { requestId: permission.id, granted: true, decidedBy: 'user', decidedAt: 1, ...decision };
      }),
      listPending: vi.fn(() => waiting),
      resolve: vi.fn(),
    };
    const standing = {
      accountEmail: vi.fn(() => 'person@example.test'),
      isAlwaysAllowed: vi.fn(() => alreadyAllowed),
      allowAlways: vi.fn(),
    };
    return { registry, standing, asked, waiting };
  }

  it('offers "Always allow" naming the account and the kind of change', async () => {
    const { registry, standing, asked } = setup({});
    await expect(authorizeConnectorMutation(registry, standing, 'session', request)).resolves.toBe(true);
    expect(asked[0].alwaysAllowCovers).toBe(
      'Always allow means no session asks again before it sends mail from person@example.test. You can take it back in Settings → MCP Servers → Connectors.',
    );
    expect(standing.allowAlways).not.toHaveBeenCalled();
  });

  it('remembers the change when James chooses "Always allow"', async () => {
    const { registry, standing } = setup({ always: true });
    await expect(authorizeConnectorMutation(registry, standing, 'session', request)).resolves.toBe(true);
    expect(standing.allowAlways).toHaveBeenCalledWith('account', 'graph_mail_send');
  });

  it('answers other cards already waiting for the same change on the same account', async () => {
    const { registry, standing, waiting } = setup({ always: true });
    const card = (id: string, toolName: string, accountKey: string, action = 'microsoft365_mutation'): PermissionRequest => ({
      id, instanceId: 'other', action, toolName, description: 'd', details: { accountKey }, createdAt: 1, timeoutMs: 1,
    });
    waiting.push(
      card('same', 'graph_mail_send', 'account'),
      card('other-change', 'graph_calendar_delete_event', 'account'),
      card('other-account', 'graph_mail_send', 'other-account'),
      card('other-kind', 'graph_mail_send', 'account', 'calendar_mutation'),
    );
    await authorizeConnectorMutation(registry, standing, 'session', request);
    expect(registry.resolve).toHaveBeenCalledTimes(1);
    expect(registry.resolve).toHaveBeenCalledWith('same', true, 'user');
  });

  it('does not ask again once the change is always allowed', async () => {
    const { registry, standing } = setup({}, true);
    await expect(authorizeConnectorMutation(registry, standing, 'session', request)).resolves.toBe(true);
    expect(registry.requestPermission).not.toHaveBeenCalled();
  });

  it.each([
    ['a denial', { granted: false }],
    ['auto-approval', { decidedBy: 'auto_approve' as const, always: true }],
    ['a timeout', { granted: false, decidedBy: 'timeout' as const }],
  ])('neither allows nor remembers after %s', async (_case, decision) => {
    const { registry, standing } = setup(decision);
    await expect(authorizeConnectorMutation(registry, standing, 'session', request)).resolves.toBe(false);
    expect(standing.allowAlways).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();
  });
});
