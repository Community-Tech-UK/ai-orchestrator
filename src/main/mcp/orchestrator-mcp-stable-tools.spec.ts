import { describe, expect, it } from 'vitest';
import type { McpServerToolDefinition } from './mcp-server-tools';
import { ORCHESTRATOR_CORE_TOOL_NAMES, REMOTE_WORKER_CORE_TOOL_NAMES } from './orchestrator-mcp-deferral';
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

  describe('remote-worker tools when no worker is connected', () => {
    const settings = ORCHESTRATOR_CORE_TOOL_NAMES.filter((name) => !REMOTE_WORKER_CORE_TOOL_NAMES.includes(name));

    it.each([undefined, true])('keeps them in the fixed core when a worker is connected or the roster is unknown (%s)', (connected) => {
      const tools = createStableOrchestratorTools(stubTools(), { remoteWorkersConnected: connected });
      expect(tools.map((tool) => tool.name)).toEqual([
        ORCHESTRATOR_TOOL_SEARCH_NAME, ORCHESTRATOR_TOOL_DESCRIBE_NAME, ORCHESTRATOR_TOOL_EXECUTE_NAME, ...ORCHESTRATOR_CORE_TOOL_NAMES,
      ]);
    });

    it('drops them from the fixed core but keeps the settings tools', () => {
      const tools = createStableOrchestratorTools(stubTools(), { remoteWorkersConnected: false });
      expect(tools.map((tool) => tool.name)).toEqual([
        ORCHESTRATOR_TOOL_SEARCH_NAME, ORCHESTRATOR_TOOL_DESCRIBE_NAME, ORCHESTRATOR_TOOL_EXECUTE_NAME, ...settings,
      ]);
    });

    it('still finds, describes and executes them through the wrapper', async () => {
      const tools = createStableOrchestratorTools(stubTools(), { remoteWorkersConnected: false });
      const byName = (name: string) => tools.find((tool) => tool.name === name)!;

      const found = (await byName(ORCHESTRATOR_TOOL_SEARCH_NAME).handler({ query: 'terminate_node_instance' })) as { matches: Array<{ name: string }> };
      expect(found.matches.map((match) => match.name)).toContain('terminate_node_instance');
      await expect(byName(ORCHESTRATOR_TOOL_DESCRIBE_NAME).handler({ name: 'run_on_node' })).resolves.toMatchObject({
        name: 'run_on_node',
        invocation: { tool: ORCHESTRATOR_TOOL_EXECUTE_NAME, name: 'run_on_node' },
      });
      await expect(byName(ORCHESTRATOR_TOOL_EXECUTE_NAME).handler({ name: 'list_remote_nodes', arguments: {} }))
        .resolves.toEqual({ name: 'list_remote_nodes' });
    });

    it('tells the model where the hidden tools are, and only when they are hidden', () => {
      const description = (connected: boolean | undefined) => createStableOrchestratorTools(stubTools(), { remoteWorkersConnected: connected })
        .find((tool) => tool.name === ORCHESTRATOR_TOOL_SEARCH_NAME)!.description;

      expect(description(false)).toMatch(/no worker node is connected/i);
      expect(description(false)).toContain('run_on_node');
      expect(description(true)).not.toMatch(/no worker node is connected/i);
      expect(description(undefined)).not.toMatch(/no worker node is connected/i);
    });
  });

  it('search and describe return invocation instructions without revealing tools', async () => {
    const tools = createStableOrchestratorTools(stubTools());
    const search = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_SEARCH_NAME)!;
    const describeTool = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_DESCRIBE_NAME)!;

    const searched = (await search.handler({ query: 'create a scheduled automation' })) as {
      matches: Array<{ name: string; description: string }>;
    };
    expect(searched.matches[0]).toMatchObject({
      name: 'create_automation',
      description: 'Create a scheduled automation in Harness',
    });

    const described = await describeTool.handler({ name: 'list_remote_nodes' });
    expect(described).toMatchObject({
      name: 'list_remote_nodes',
      invocation: { tool: 'list_remote_nodes' },
    });
  });

  it('discovers both host process tools in the full catalog with the default limit', async () => {
    const { createOrchestratorToolsForwarderTools } = await import('./orchestrator-tools-mcp-forwarder');
    const tools = createStableOrchestratorTools(
      createOrchestratorToolsForwarderTools({ call: async () => ({}) }),
    );
    const search = tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_SEARCH_NAME)!;
    const result = (await search.handler({ query: 'process' })) as {
      matches: Array<{ name: string; description: string }>;
    };
    expect(result.matches.length).toBeLessThanOrEqual(5);
    for (const name of ['list_host_processes', 'stop_leftover_processes']) {
      // Search names and describes (Oct-2 T10); tool_describe returns the schema and how to run the tool.
      expect(result.matches).toContainEqual({ name, description: expect.any(String) });
      const described = await tools.find((tool) => tool.name === ORCHESTRATOR_TOOL_DESCRIBE_NAME)!.handler({ name });
      expect(described).toMatchObject({
        name, inputSchema: expect.objectContaining({ type: 'object' }), invocation: { tool: ORCHESTRATOR_TOOL_EXECUTE_NAME, name },
      });
      expect(tools.map((tool) => tool.name)).not.toContain(name);
    }
  });
});
