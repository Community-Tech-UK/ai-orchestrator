import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpToolBridge } from '../mcp-tool-bridge';

describe('McpToolBridge', () => {
  beforeEach(() => {
    McpToolBridge._resetForTesting();
  });

  it('registers MCP tools with qualified names', () => {
    const bridge = McpToolBridge.getInstance();
    bridge.registerServerTools('my-db', [
      { name: 'query', description: 'Run a SQL query', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } },
    ]);

    const tools = bridge.getRegisteredTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe('mcp__my-db__query');
    expect(tools[0].description).toContain('Run a SQL query');
  });

  it('routes tool execution through callToolFn', async () => {
    const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });
    const bridge = McpToolBridge.getInstance();
    bridge.setCallToolFn(mockCallTool);
    bridge.registerServerTools('my-db', [
      { name: 'query', description: 'SQL', inputSchema: { type: 'object' } },
    ]);

    await bridge.executeTool('mcp__my-db__query', { sql: 'SELECT 1' });
    expect(mockCallTool).toHaveBeenCalledWith({ serverId: 'my-db', toolName: 'query', args: { sql: 'SELECT 1' } });
  });

  it('throws on unknown tool', async () => {
    const bridge = McpToolBridge.getInstance();
    bridge.setCallToolFn(vi.fn());
    await expect(bridge.executeTool('mcp__unknown__tool', {})).rejects.toThrow('Unknown MCP tool');
  });

  it('replaces tools on re-registration', () => {
    const bridge = McpToolBridge.getInstance();
    bridge.registerServerTools('srv', [{ name: 'a', description: 'A', inputSchema: {} }]);
    expect(bridge.getRegisteredTools()).toHaveLength(1);
    bridge.registerServerTools('srv', [
      { name: 'b', description: 'B', inputSchema: {} },
      { name: 'c', description: 'C', inputSchema: {} },
    ]);
    expect(bridge.getRegisteredTools()).toHaveLength(2);
    expect(bridge.getRegisteredTools().map(t => t.toolName).sort()).toEqual(['b', 'c']);
  });

  it('unregisters server tools', () => {
    const bridge = McpToolBridge.getInstance();
    bridge.registerServerTools('srv', [{ name: 'a', description: 'A', inputSchema: {} }]);
    bridge.unregisterServerTools('srv');
    expect(bridge.getRegisteredTools()).toHaveLength(0);
  });
});
