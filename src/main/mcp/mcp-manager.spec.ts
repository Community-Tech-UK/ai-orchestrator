import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { McpManager } from './mcp-manager';
import { _resetMCPToolSearchServiceForTesting, getMCPToolSearchService } from './mcp-tool-search';

describe('McpManager', () => {
  let manager: McpManager;

  beforeEach(() => {
    _resetMCPToolSearchServiceForTesting();
    manager = new McpManager();
  });

  afterEach(async () => {
    await manager.shutdown();
    _resetMCPToolSearchServiceForTesting();
  });

  it('does not deduplicate stdio servers with different env values', () => {
    manager.addServer({
      id: 'server-a',
      name: 'Server A',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_TOKEN: 'token-a' },
    });
    manager.addServer({
      id: 'server-b',
      name: 'Server B',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_TOKEN: 'token-b' },
    });

    expect(manager.getServers().map((server) => server.id)).toEqual(['server-a', 'server-b']);
  });

  it('cleans up an HTTP transport when initialize fails', async () => {
    const { server, url } = await startHttpMcpServer(() => ({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'initialize failed' },
    }));
    const disconnected: string[] = [];
    manager.on('server:disconnected', (serverId) => disconnected.push(serverId));
    manager.addServer({
      id: 'http-broken',
      name: 'Broken HTTP',
      transport: 'http',
      url,
    });

    await expect(manager.connect('http-broken')).rejects.toThrow('initialize failed');

    expect(disconnected).toEqual(['http-broken']);
    expect(manager.getServerStatus('http-broken')).toMatchObject({
      status: 'error',
      error: 'initialize failed',
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('builds runtime context by loading only tools relevant to the prompt query', async () => {
    const search = getMCPToolSearchService();
    search.registerServer({
      id: 'data',
      name: 'Data MCP',
      description: 'Database and analytics tools',
      uri: 'stdio://data',
      status: 'connected',
      tools: [],
      resources: [],
      lastSeen: 1,
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        sampling: false,
      },
    });
    search.indexTool({
      id: 'data:query_database',
      name: 'query_database',
      description: 'Run SQL database queries and inspect relational schemas.',
      serverId: 'data',
      serverName: 'Data MCP',
      inputSchema: { type: 'object' },
      tags: ['database'],
      metadata: {},
    });
    search.indexTool({
      id: 'data:create_slides',
      name: 'create_slides',
      description: 'Create presentation slides from an outline.',
      serverId: 'data',
      serverName: 'Data MCP',
      inputSchema: { type: 'object' },
      tags: ['presentation'],
      metadata: {},
    });

    const context = await (manager as unknown as {
      getRuntimeToolContext(options: { query: string; maxTools: number }): Promise<{
        selectedTools: { id: string }[];
        deferredToolCount: number;
      }>;
      formatRuntimeToolContext(context: unknown): string | null;
    }).getRuntimeToolContext({ query: 'inspect database schema', maxTools: 1 });
    const prompt = (manager as unknown as {
      formatRuntimeToolContext(context: unknown): string | null;
    }).formatRuntimeToolContext(context);

    expect(context.selectedTools).toEqual([expect.objectContaining({ id: 'data:query_database' })]);
    expect(context.deferredToolCount).toBe(1);
    expect(search.isToolLoaded('data:query_database')).toBe(true);
    expect(search.isToolLoaded('data:create_slides')).toBe(false);
    expect(prompt).toContain('Data MCP');
    expect(prompt).toContain('query_database');
    expect(prompt).toContain('Run SQL database queries');
    expect(prompt).not.toContain('Create presentation slides');
  });

  it('does not let previously loaded tools displace current query matches', async () => {
    const search = getMCPToolSearchService();
    search.registerServer({
      id: 'data',
      name: 'Data MCP',
      description: 'Database and analytics tools',
      uri: 'stdio://data',
      status: 'connected',
      tools: [],
      resources: [],
      lastSeen: 1,
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        sampling: false,
      },
    });
    search.indexTool({
      id: 'data:create_slides',
      name: 'create_slides',
      description: 'Create presentation slides from an outline.',
      serverId: 'data',
      serverName: 'Data MCP',
      inputSchema: { type: 'object' },
      tags: ['presentation'],
      metadata: {},
    });
    search.indexTool({
      id: 'data:query_database',
      name: 'query_database',
      description: 'Run SQL database queries and inspect relational schemas.',
      serverId: 'data',
      serverName: 'Data MCP',
      inputSchema: { type: 'object' },
      tags: ['database'],
      metadata: {},
    });
    await search.loadTool('data:create_slides');

    const context = await manager.getRuntimeToolContext({ query: 'inspect database schema', maxTools: 1 });
    const prompt = manager.formatRuntimeToolContext(context);

    expect(context.selectedTools).toEqual([expect.objectContaining({ id: 'data:query_database' })]);
    expect(search.isToolLoaded('data:create_slides')).toBe(true);
    expect(search.isToolLoaded('data:query_database')).toBe(true);
    expect(prompt).toContain('query_database');
    expect(prompt).not.toContain('create_slides');
  });

  it('surfaces Orchestrator remote-node tools for Windows PC prompts with inspect-first guidance', async () => {
    const search = getMCPToolSearchService();
    search.registerServer({
      id: 'orchestrator',
      name: 'Orchestrator Tools',
      description: 'AIO parent-side orchestration tools',
      uri: 'stdio://aio-mcp/orchestrator-tools',
      status: 'connected',
      tools: [],
      resources: [],
      lastSeen: 1,
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        sampling: false,
      },
    });
    search.indexTool({
      id: 'orchestrator:list_remote_nodes',
      name: 'list_remote_nodes',
      description:
        'Inspect connected remote worker nodes before using another machine, including Windows PCs, remote machines, and other computers.',
      serverId: 'orchestrator',
      serverName: 'Orchestrator Tools',
      inputSchema: { type: 'object' },
      tags: ['remote', 'worker-node'],
      metadata: {},
    });
    search.indexTool({
      id: 'orchestrator:run_on_node',
      name: 'run_on_node',
      description:
        'Run a task on a connected remote worker node such as a Windows PC, remote machine, or other machine.',
      serverId: 'orchestrator',
      serverName: 'Orchestrator Tools',
      inputSchema: { type: 'object' },
      tags: ['remote', 'worker-node'],
      metadata: {},
    });

    const context = await manager.getRuntimeToolContext({ query: 'use my Windows PC', maxTools: 1 });
    const prompt = manager.formatRuntimeToolContext(context);

    expect(context.selectedTools).toEqual([
      expect.objectContaining({ id: 'orchestrator:list_remote_nodes' }),
    ]);
    expect(prompt).toContain('Windows PCs, laptops, desktops, named machines');
    expect(prompt).toContain('for example "Noah\'s laptop"');
    expect(prompt).toContain('check list_remote_nodes before local filesystem');
  });

  it('surfaces Browser Gateway guidance for shared Mac tabs and remote PC preference', async () => {
    const search = getMCPToolSearchService();
    search.registerServer({
      id: 'browser-gateway',
      name: 'Browser Gateway',
      description: 'Shared Chrome tab bridge',
      uri: 'stdio://aio-mcp/browser-gateway',
      status: 'connected',
      tools: [],
      resources: [],
      lastSeen: 1,
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        sampling: false,
      },
    });
    search.indexTool({
      id: 'browser-gateway:browser.list_targets',
      name: 'browser.list_targets',
      description: 'List Browser Gateway shared Chrome tabs.',
      serverId: 'browser-gateway',
      serverName: 'Browser Gateway',
      inputSchema: { type: 'object' },
      tags: ['browser'],
      metadata: {},
    });

    const context = await manager.getRuntimeToolContext({
      query: 'the tab is open on my Mac and shared',
      maxTools: 1,
    });
    const prompt = manager.formatRuntimeToolContext(context);

    expect(prompt).toContain('prefer connected remote PCs');
    expect(prompt).toContain('use local/Mac shared tabs when the user explicitly says');
    expect(prompt).toContain('browser.list_targets');
  });
});

async function startHttpMcpServer(
  responseFor: (message: { id?: number; method?: string }) => unknown,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method?: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseFor(message)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}
