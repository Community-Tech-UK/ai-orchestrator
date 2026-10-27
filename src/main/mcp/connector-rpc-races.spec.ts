import { describe, expect, it, vi } from 'vitest';
import { dispatchConnectorRpc } from './connector-rpc';
import { ConnectorAccessRegistry } from './connector-access';
import { callGraphConnectorTool, type GraphConnectorDependencies } from './connector-graph-tools';
import { GraphClient, type GraphRequestContext } from '../graph/graph-client';

function setup() {
  const access = new ConnectorAccessRegistry();
  access.grant('session', ['connector']);
  const record = { id: 'connector', name: 'm365-example', kind: 'microsoft365' as const,
    accountId: 'account', autoConnect: true, mailEnabled: true, updatedAt: 1 };
  let records = [{ record }];
  let asked!: () => void;
  const approvalRequested = new Promise<void>((resolve) => { asked = resolve; });
  let answer!: (value: boolean) => void;
  const approval = new Promise<boolean>((resolve) => { answer = resolve; });
  let tokenHook: () => Promise<void> = async () => undefined;
  const fetch = vi.fn(async () => new Response(null, { status: 202 }));
  const runtime = {
    access, repo: { list: () => records }, auth: { getAccessToken: vi.fn() },
    graph: {
      listTools: () => [],
      callTool: (account: string, name: string, args: Record<string, unknown>, mail = false,
        authorize?: GraphConnectorDependencies['authorizeMutation'], requestContext?: GraphRequestContext) =>
        callGraphConnectorTool(account, name, args, {
          authManager: { connectAccount: vi.fn(), listAccounts: async () => [{ accountKey: 'account', username: 'writable@example.test' }] },
          writableAccountEmails: ['writable@example.test'],
          authorizeMutation: authorize,
          graphClient: new GraphClient({
            tokenProvider: { getAccessToken: async () => { await tokenHook(); return 'TOKEN_PLACEHOLDER'; } },
            fetch, requestContext,
          }),
        }, mail),
    },
    authorizeMutation: async () => { asked(); return approval; },
  };
  const call = (context: GraphRequestContext = {}) => dispatchConnectorRpc('connectors.graph', 'session', {
    name: 'm365-example', method: 'tools/call', params: { name: 'graph_mail_send', arguments: { messageId: 'draft-placeholder' } },
  }, runtime, context);
  return { record, access, fetch, answer, approvalRequested, call,
    remove: () => { records = []; },
    duringToken: (hook: typeof tokenHook) => { tokenHook = hook; } };
}

describe('Microsoft 365 connector mutation ownership', () => {
  it.each(['disabled', 'deleted', 'mail-disabled', 'rebound', 'replaced', 'grant-removed'])(
    'refuses a %s connector after approval without sending the draft', async (change) => {
      const test = setup();
      const operation = test.call();
      await test.approvalRequested;
      switch (change) {
        case 'disabled': test.record.autoConnect = false; break;
        case 'deleted': test.remove(); break;
        case 'mail-disabled': test.record.mailEnabled = false; break;
        case 'rebound': test.record.accountId = 'another-account'; break;
        case 'replaced': test.record.id = 'different-connector'; break;
        case 'grant-removed': test.access.grant('session', []); break;
      }
      test.answer(true);
      await expect(operation).rejects.toThrow();
      expect(test.fetch).not.toHaveBeenCalled();
    },
  );

  it('rechecks connector ownership after token retrieval immediately before sending', async () => {
    const test = setup();
    test.duringToken(async () => { test.record.autoConnect = false; });
    const operation = test.call();
    await test.approvalRequested;
    test.answer(true);
    await expect(operation).rejects.toThrow();
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it('rejects a disconnected request while approval is pending, even before a decision arrives', async () => {
    const test = setup();
    const controller = new AbortController();
    const operation = test.call({ signal: controller.signal });
    let rejected = false;
    const settled = operation.then(() => undefined, () => { rejected = true; });
    await test.approvalRequested;
    controller.abort();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejected).toBe(true);
    } finally {
      test.answer(false);
      await settled;
    }
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it('refuses a terminated session after approval', async () => {
    const test = setup();
    let active = true;
    const operation = test.call({ assertActive: () => { if (!active) throw new Error('session ended'); } });
    await test.approvalRequested;
    active = false;
    test.answer(true);
    await expect(operation).rejects.toThrow('session ended');
    expect(test.fetch).not.toHaveBeenCalled();
  });
});
