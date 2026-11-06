import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from './mcp-server';
import { createDeferredOrchestratorTools } from './orchestrator-mcp-deferral';
import { createStableOrchestratorTools } from './orchestrator-mcp-stable-tools';
import type { McpServerToolDefinition } from './mcp-server-tools';

const tool: McpServerToolDefinition = {
  name: 'read_example', description: 'Read an example.\nMore details.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Large schema detail '.repeat(200) } } },
  handler: async () => ({}),
};
beforeEach(() => McpServer._resetForTesting());
describe('orchestrator discovery budget', () => {
  it.each(['deferred', 'stable'])('%s search returns summaries and describe returns the schema', async (mode) => {
    const tools = mode === 'stable' ? createStableOrchestratorTools([tool]) : createDeferredOrchestratorTools([tool], { onReveal: vi.fn() });
    const result = await tools.find(tool => tool.name === 'orchestrator.tool_search')!.handler({ query: 'read example' }) as { matches: unknown[] };
    expect(result.matches).toEqual([{ name: 'read_example', description: 'Read an example. More details.' }]);
    expect(await tools.find(tool => tool.name === 'orchestrator.tool_describe')!.handler({ name: tool.name }))
      .toMatchObject({ inputSchema: tool.inputSchema });
  });

  it('advertises annotations for every registered tool, with reads and destructive operations distinguished', async () => {
    const server = McpServer.getInstance();
    server.registerTools([tool, { ...tool, name: 'terminate_node_instance' }, { ...tool, name: 'browser.close' }]);
    const result = await server.handleRequest({ method: 'tools/list' }) as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> };
    expect(result.tools.every(tool => typeof tool.annotations?.readOnlyHint === 'boolean')).toBe(true);
    expect(result.tools.find(tool => tool.name === 'read_example')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of ['terminate_node_instance', 'browser.close']) expect(result.tools.find(tool => tool.name === name)?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
