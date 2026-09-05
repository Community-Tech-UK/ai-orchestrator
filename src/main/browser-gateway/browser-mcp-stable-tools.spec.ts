import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '../mcp/mcp-server';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { BrowserGatewayRpcClient } from './browser-gateway-rpc-client';
import { createStableBrowserMcpTools, BROWSER_TOOL_EXECUTE_NAME } from './browser-mcp-stable-tools';
import { createBrowserMcpTools } from './browser-mcp-tools';
import { measureToolSchemaBytes } from './browser-mcp-deferral';

function textResult(result: unknown): unknown {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}

describe('stable browser MCP discovery and authenticated RPC execution', () => {
  let rpc: BrowserGatewayRpcServer;
  let server: McpServer;
  const evaluate = vi.fn();
  const fillCredential = vi.fn();
  beforeEach(async () => {
    McpServer._resetForTesting();
    evaluate.mockReset().mockResolvedValue({ decision: 'requires_user', requestId: 'approval-placeholder' });
    fillCredential.mockReset().mockResolvedValue({ decision: 'denied', reason: 'credential_authorization_required' });
    rpc = new BrowserGatewayRpcServer({
      service: { evaluate, fillCredential },
      userDataPath: '/tmp', isKnownLocalInstance: id => id === 'instance-placeholder',
      registerCleanup: vi.fn(), routeBrowserRequest: (_method, payload) => payload,
    });
    await rpc.start();
    server = McpServer.getInstance();
    server.registerTools(createStableBrowserMcpTools(new BrowserGatewayRpcClient({ env: {
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: rpc.getSocketPath()!,
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-placeholder',
      AI_ORCHESTRATOR_BROWSER_PROVIDER: 'codex',
    } })));
  });
  afterEach(async () => { await rpc.stop(); });

  const invoke = (getServer: () => McpServer, name: string, args: unknown) =>
    getServer().handleRequest({ method: 'tools/call', params: { name, arguments: args } });

  it('discovers then executes with only initial wrappers, without list changes', async () => {
    const initial = await server.handleRequest({ method: 'tools/list' });
    const changed = vi.fn();
    server.on('tools-list-changed', changed);
    const search = textResult(await invoke(() => server, 'browser.tool_search', { query: 'browser.evaluate' })) as {
      matches: { name: string }[];
    };
    expect(search.matches.map(match => match.name)).toContain('browser.evaluate');
    const description = textResult(await invoke(() => server, 'browser.tool_describe', { name: 'browser.evaluate' }));
    expect(description).toMatchObject({
      inputSchema: createBrowserMcpTools({ call: vi.fn() }).find(tool => tool.name === 'browser.evaluate')!.inputSchema,
      invocation: { tool: BROWSER_TOOL_EXECUTE_NAME, name: 'browser.evaluate' },
    });
    expect(textResult(await invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, {
      name: 'browser.evaluate', arguments: { profileId: 'profile-placeholder', targetId: 'target-placeholder', expression: '1 + 1' },
    }))).toEqual({ decision: 'requires_user', requestId: 'approval-placeholder' });
    expect(evaluate).toHaveBeenCalledWith({
      instanceId: 'instance-placeholder', provider: 'codex',
      profileId: 'profile-placeholder', targetId: 'target-placeholder', expression: '1 + 1',
    });
    expect(await server.handleRequest({ method: 'tools/list' })).toEqual(initial);
    expect(changed).not.toHaveBeenCalled();
  });

  it('preserves parent argument validation before policy dispatch', async () => {
    const result = textResult(await invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, {
      name: 'browser.evaluate', arguments: { profileId: 'profile-placeholder', targetId: 42 },
    }));
    expect(result).toMatchObject({ decision: 'denied', reason: 'invalid_browser_gateway_rpc_payload' });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('preserves strict credential validation and credential policy refusals', async () => {
    const args = {
      profileId: 'profile-placeholder', targetId: 'target-placeholder', vaultItemRef: 'vault-placeholder',
      fields: [{ selector: '#password', kind: 'password' }],
    };
    expect(textResult(await invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, {
      name: 'browser.fill_credential', arguments: { ...args, bypassAuthorization: true },
    }))).toMatchObject({ decision: 'denied', reason: 'invalid_browser_gateway_rpc_payload' });
    expect(fillCredential).not.toHaveBeenCalled();
    expect(textResult(await invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, {
      name: 'browser.fill_credential', arguments: args,
    }))).toEqual({ decision: 'denied', reason: 'credential_authorization_required' });
    expect(fillCredential).toHaveBeenCalledWith({ ...args, instanceId: 'instance-placeholder', provider: 'codex' });
  });

  it('cannot execute private RPC methods, recurse, or smuggle envelope fields', async () => {
    for (const name of ['browser.extension_poll_command', 'browser.tool_reveal_record', BROWSER_TOOL_EXECUTE_NAME]) {
      await expect(invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, { name, arguments: {} })).rejects.toThrow('Unknown browser tool');
    }
    for (const args of [null, [], { name: 'browser.evaluate', arguments: [] }, {
      name: 'browser.evaluate', arguments: {}, instanceId: 'other-placeholder',
    }]) {
      await expect(invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, args)).rejects.toThrow('Invalid browser tool execute arguments');
    }
  });

  it('authenticates via the original RPC envelope', async () => {
    const tools = createStableBrowserMcpTools(new BrowserGatewayRpcClient({ env: {
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: rpc.getSocketPath()!,
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'unknown-placeholder',
    } }));
    server.registerTools(tools);
    expect(textResult(await invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, {
      name: 'browser.evaluate', arguments: { profileId: 'profile-placeholder', targetId: 'target-placeholder', expression: '1' },
    }))).toMatchObject({ decision: 'denied', reason: 'unknown_browser_gateway_instance' });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps the image tool direct and measures a smaller fixed schema surface', async () => {
    const client = { call: vi.fn().mockResolvedValue({ data: 'iVBORw0KGgoPLACEHOLDER', decision: 'allowed' }) };
    const stable = createStableBrowserMcpTools(client);
    server.registerTools(stable);
    const result = await invoke(() => server, 'browser.screenshot', { profileId: 'p', targetId: 't' });
    expect(result).toMatchObject({ content: [ { type: 'image', mimeType: 'image/png' }, { type: 'text' } ] });
    await expect(invoke(() => server, BROWSER_TOOL_EXECUTE_NAME, { name: 'browser.screenshot', arguments: {} }))
      .rejects.toThrow('directly registered core');
    expect(stable).toHaveLength(9);
    expect(measureToolSchemaBytes(stable)).toBeLessThan(measureToolSchemaBytes(createBrowserMcpTools(client)) / 2);
  });
});
