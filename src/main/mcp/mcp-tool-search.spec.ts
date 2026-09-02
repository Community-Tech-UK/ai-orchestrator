import { describe, expect, it } from 'vitest';

import { MCPToolSearchService, type MCPTool } from './mcp-tool-search';

function tool(name: string, serverId: string): MCPTool {
  return {
    id: `${serverId}:${name}`,
    name,
    description: name,
    serverId,
    serverName: serverId,
    inputSchema: {},
    tags: [],
    metadata: {},
  };
}

function register(service: MCPToolSearchService, serverId: string, tools: MCPTool[]): void {
  service.registerServer({
    id: serverId,
    name: serverId,
    uri: `stdio://${serverId}`,
    status: 'connected',
    tools: tools.map((entry) => entry.id),
    resources: [],
    lastSeen: 1,
    capabilities: { tools: true, resources: false, prompts: false, sampling: false },
  });
  tools.forEach((entry) => service.indexTool(entry));
}

describe('MCPToolSearchService browser routing hints', () => {
  it('describes run_on_node browser work as worker-managed Chrome only', () => {
    const service = new MCPToolSearchService();
    register(service, 'orchestrator', [tool('run_on_node', 'orchestrator')]);

    const hint = service.getServerSummaries()[0]?.searchHint ?? '';

    expect(hint).toContain('worker-managed Chrome');
    expect(hint).toContain('cannot access Browser Gateway');
    expect(hint).toContain('stay on the coordinator');
  });

  it('keeps Browser Gateway shared-tab work on the coordinator', () => {
    const service = new MCPToolSearchService();
    register(service, 'browser-gateway', [tool('browser.list_targets', 'browser-gateway')]);

    const hint = service.getServerSummaries()[0]?.searchHint ?? '';

    expect(hint).toContain('existing and extension-shared Chrome tabs');
    expect(hint).toContain('stay on the coordinator');
    expect(hint).toContain('computer');
    expect(hint).not.toContain('prefer connected remote PCs');
  });
});
