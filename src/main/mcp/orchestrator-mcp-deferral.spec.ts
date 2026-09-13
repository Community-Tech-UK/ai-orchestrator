import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from './mcp-server';
import type { McpServerToolDefinition } from './mcp-server-tools';
import {
  ORCHESTRATOR_CORE_TOOL_NAMES,
  ORCHESTRATOR_TOOL_DESCRIBE_NAME,
  ORCHESTRATOR_TOOL_SEARCH_NAME,
  createDeferredOrchestratorTools,
  measureOrchestratorToolSchemaBytes,
} from './orchestrator-mcp-deferral';

function stubTools(): McpServerToolDefinition[] {
  return [
    ...ORCHESTRATOR_CORE_TOOL_NAMES.map((name) => ({
      name,
      description: `${name} core tool`,
      inputSchema: { type: 'object' },
      handler: async () => ({ name }),
    })),
    {
      name: 'create_automation',
      description: 'Create a scheduled automation in Harness',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      handler: async (args) => ({ created: args }),
    },
    {
      name: 'upload_to_node',
      description: 'Upload one local workspace file to a worker node',
      inputSchema: { type: 'object', properties: { node: { type: 'string' } } },
      handler: async () => ({ uploaded: true }),
    },
  ];
}

describe('orchestrator-mcp-deferral', () => {
  beforeEach(() => {
    McpServer._resetForTesting();
  });

  it('lists only the core tools plus search and describe', () => {
    const tools = createDeferredOrchestratorTools(stubTools(), { onReveal: vi.fn() });
    const visible = tools.filter((tool) => !tool.hidden).map((tool) => tool.name);

    expect(visible).toEqual(expect.arrayContaining([
      ORCHESTRATOR_TOOL_SEARCH_NAME,
      ORCHESTRATOR_TOOL_DESCRIBE_NAME,
      ...ORCHESTRATOR_CORE_TOOL_NAMES,
    ]));
    expect(visible).not.toContain('create_automation');
    expect(visible).not.toContain('upload_to_node');
    expect(visible.length).toBe(ORCHESTRATOR_CORE_TOOL_NAMES.length + 2);
  });

  it('keeps hidden tools dispatchable and reveals matches from search', async () => {
    const onReveal = vi.fn();
    const tools = createDeferredOrchestratorTools(stubTools(), { onReveal });
    const search = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_SEARCH_NAME)!;
    const hidden = tools.find((tool) => tool.name === 'create_automation')!;

    await expect(hidden.handler({ name: 'nightly' })).resolves.toEqual({
      created: { name: 'nightly' },
    });

    const result = (await search.handler({ query: 'create a scheduled automation' })) as {
      matches: Array<{ name: string }>;
    };
    expect(result.matches.map((match) => match.name)).toContain('create_automation');
    expect(onReveal).toHaveBeenCalledWith(expect.arrayContaining(['create_automation']));
  });

  it('describe returns one schema and reveals it', async () => {
    const onReveal = vi.fn();
    const tools = createDeferredOrchestratorTools(stubTools(), { onReveal });
    const describeTool = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_DESCRIBE_NAME)!;

    const known = (await describeTool.handler({ name: 'upload_to_node' })) as { name: string };
    expect(known.name).toBe('upload_to_node');
    expect(onReveal).toHaveBeenCalledWith(['upload_to_node']);
  });

  it('search then list_changed makes a hidden tool visible on the MCP server', async () => {
    const server = McpServer.getInstance();
    server.registerTools(
      createDeferredOrchestratorTools(stubTools(), {
        onReveal: (names) => server.revealTools(names),
      }),
    );

    const initial = (await server.handleRequest({ method: 'tools/list' })) as {
      tools: Array<{ name: string }>;
    };
    expect(initial.tools.map((tool) => tool.name)).not.toContain('upload_to_node');

    const listChanged = vi.fn();
    server.on('tools-list-changed', listChanged);
    await server.handleRequest({
      method: 'tools/call',
      params: { name: ORCHESTRATOR_TOOL_SEARCH_NAME, arguments: { query: 'upload a file' } },
    });
    expect(listChanged).toHaveBeenCalled();

    const revealed = (await server.handleRequest({ method: 'tools/list' })) as {
      tools: Array<{ name: string }>;
    };
    expect(revealed.tools.map((tool) => tool.name)).toContain('upload_to_node');
  });

  it('visible deferred schemas are smaller than the full surface', async () => {
    const { createOrchestratorToolsForwarderTools } = await import('./orchestrator-tools-mcp-forwarder');
    const full = createOrchestratorToolsForwarderTools({ call: async () => ({}) });
    const deferred = createDeferredOrchestratorTools(full, { onReveal: vi.fn() });
    expect(measureOrchestratorToolSchemaBytes(deferred.filter((tool) => !tool.hidden)))
      .toBeLessThan(measureOrchestratorToolSchemaBytes(full) / 2);
  });
});
