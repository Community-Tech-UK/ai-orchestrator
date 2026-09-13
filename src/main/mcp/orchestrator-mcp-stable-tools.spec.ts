import { describe, expect, it } from 'vitest';
import type { McpServerToolDefinition } from './mcp-server-tools';
import { ORCHESTRATOR_CORE_TOOL_NAMES } from './orchestrator-mcp-deferral';
import {
  ORCHESTRATOR_TOOL_EXECUTE_NAME,
  createStableOrchestratorTools,
} from './orchestrator-mcp-stable-tools';
import {
  ORCHESTRATOR_TOOL_DESCRIBE_NAME,
  ORCHESTRATOR_TOOL_SEARCH_NAME,
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
  ];
}

describe('orchestrator-mcp-stable-tools', () => {
  it('exposes a fixed core plus search, describe, and execute', () => {
    const tools = createStableOrchestratorTools(stubTools());
    expect(tools.map((tool) => tool.name)).toEqual([
      ORCHESTRATOR_TOOL_SEARCH_NAME,
      ORCHESTRATOR_TOOL_DESCRIBE_NAME,
      ORCHESTRATOR_TOOL_EXECUTE_NAME,
      ...ORCHESTRATOR_CORE_TOOL_NAMES,
    ]);
    expect(tools.every((tool) => !tool.hidden)).toBe(true);
  });

  it('executes a hidden tool through the wrapper and refuses core tools', async () => {
    const tools = createStableOrchestratorTools(stubTools());
    const execute = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_EXECUTE_NAME)!;

    await expect(execute.handler({
      name: 'create_automation',
      arguments: { name: 'nightly' },
    })).resolves.toEqual({ created: { name: 'nightly' } });

    await expect(execute.handler({
      name: 'list_remote_nodes',
      arguments: {},
    })).rejects.toThrow(/directly registered core/i);
  });

  it('search and describe return invocation instructions without revealing tools', async () => {
    const tools = createStableOrchestratorTools(stubTools());
    const search = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_SEARCH_NAME)!;
    const describeTool = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_DESCRIBE_NAME)!;

    const searched = (await search.handler({ query: 'create a scheduled automation' })) as {
      matches: Array<{ name: string; invocation: { tool: string; name?: string } }>;
    };
    expect(searched.matches[0]).toMatchObject({
      name: 'create_automation',
      invocation: { tool: ORCHESTRATOR_TOOL_EXECUTE_NAME, name: 'create_automation' },
    });

    const described = await describeTool.handler({ name: 'list_remote_nodes' });
    expect(described).toMatchObject({
      name: 'list_remote_nodes',
      invocation: { tool: 'list_remote_nodes' },
    });
  });
});
