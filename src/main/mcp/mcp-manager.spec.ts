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
        selectedTools: Array<{ id: string }>;
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
