import { describe, expect, it } from 'vitest';
import { estimateServerCost } from './mcp-token-estimate';
describe('MCP token estimate', () => {
  it('estimates complete schemas and names separately', () => {
    const tool = { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } };
    expect(estimateServerCost([tool])).toEqual({ toolCount: 1, fullTokens: Math.ceil(JSON.stringify(tool).length / 4), nameTokens: 2 });
    expect(estimateServerCost([])).toEqual({ toolCount: 0, fullTokens: 0, nameTokens: 0 });
  });
});
