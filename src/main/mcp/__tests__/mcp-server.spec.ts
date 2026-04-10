import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '../mcp-server';
import { createOrchestratorTools } from '../mcp-server-tools';

describe('McpServer', () => {
  beforeEach(() => {
    McpServer._resetForTesting();
  });

  it('handles initialize request', async () => {
    const server = McpServer.getInstance();
    const result = await server.handleRequest({ method: 'initialize', id: 1 });
    expect(result).toHaveProperty('protocolVersion');
    expect(result).toHaveProperty('capabilities');
  });

  it('lists registered tools', async () => {
    const server = McpServer.getInstance();
    const tools = createOrchestratorTools({
      listInstances: vi.fn(),
      spawnInstance: vi.fn(),
      verify: vi.fn(),
      debate: vi.fn(),
      consensus: vi.fn(),
    });
    server.registerTools(tools);

    const result = await server.handleRequest({ method: 'tools/list', id: 2 }) as { tools: unknown[] };
    expect(result.tools).toHaveLength(5);
  });

  it('calls a tool', async () => {
    const server = McpServer.getInstance();
    const mockListInstances = vi.fn().mockResolvedValue([{ id: 'inst-1' }]);
    server.registerTools(createOrchestratorTools({
      listInstances: mockListInstances,
      spawnInstance: vi.fn(),
      verify: vi.fn(),
      debate: vi.fn(),
      consensus: vi.fn(),
    }));

    const result = await server.handleRequest({
      method: 'tools/call',
      params: { name: 'orchestrator.list_instances', arguments: {} },
      id: 3,
    }) as { content: { text: string }[] };

    expect(mockListInstances).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toEqual([{ id: 'inst-1' }]);
  });

  it('throws on unknown tool', async () => {
    const server = McpServer.getInstance();
    await expect(server.handleRequest({
      method: 'tools/call',
      params: { name: 'nonexistent' },
      id: 4,
    })).rejects.toThrow('Unknown tool');
  });

  it('tracks started/stopped state', () => {
    const server = McpServer.getInstance();
    expect(server.isStarted()).toBe(false);
    server.start();
    expect(server.isStarted()).toBe(true);
    server.stop();
    expect(server.isStarted()).toBe(false);
  });
});
