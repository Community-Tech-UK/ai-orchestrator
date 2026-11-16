import { describe, expect, it, vi } from 'vitest';
import { createBrowserMcpTools } from './browser-mcp-tools';
import { createStableBrowserMcpTools } from './browser-mcp-stable-tools';

const requests = [
  { name: 'browser.start_device_login', args: { nodeId: 'worker-1', profileId: 'codex-campaign' } },
  { name: 'browser.read_device_login', args: { loginHandle: '00000000-0000-4000-8000-000000000001' } },
  { name: 'browser.cancel_device_login', args: { loginHandle: '00000000-0000-4000-8000-000000000001' } },
  { name: 'browser.fill_device_login', args: {
    loginHandle: '00000000-0000-4000-8000-000000000001', profileId: 'browser-profile', targetId: 'tab-1',
  } },
];

describe('device login MCP discovery', () => {
  it('finds the secure Codex sign-in route by task words', async () => {
    const search = createStableBrowserMcpTools({ call: vi.fn() })
      .find(tool => tool.name === 'browser.tool_search')!;
    await expect(search.handler({ query: 'Codex device login', limit: 10 })).resolves.toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({ name: 'browser.start_device_login' }),
        expect.objectContaining({ name: 'browser.fill_device_login' }),
      ]),
    });
  });

  it.each(requests)('advertises only required public references for $name', ({ name, args }) => {
    const tool = createBrowserMcpTools({ call: vi.fn() }).find(candidate => candidate.name === name);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema['additionalProperties']).toBe(false);
    expect(Object.keys(tool!.inputSchema['properties'] as object)).toEqual(Object.keys(args));
    expect(tool!.inputSchema['required']).toEqual(Object.keys(args));
  });

  it.each(requests)('describes and dispatches $name through the stable authenticated RPC route', async ({ name, args }) => {
    const view = { loginHandle: '00000000-0000-4000-8000-000000000001', status: 'pending' };
    const call = vi.fn().mockResolvedValue(view);
    const tools = createStableBrowserMcpTools({ call });
    const describeTool = tools.find(tool => tool.name === 'browser.tool_describe')!;
    await expect(describeTool.handler({ name })).resolves.toMatchObject({
      name, invocation: { tool: 'browser.tool_execute', name },
      inputSchema: { additionalProperties: false },
    });
    const execute = tools.find(tool => tool.name === 'browser.tool_execute')!;
    await expect(execute.handler({ name, arguments: args })).resolves.toEqual(view);
    expect(call).toHaveBeenCalledExactlyOnceWith(name, args);
  });
});
