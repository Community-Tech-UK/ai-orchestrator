import { describe, expect, it } from 'vitest';
import { createCodememMcpTools } from '../mcp-tools';
import type { AgentLspFacade } from '../agent-lsp-facade';

describe('createCodememMcpTools', () => {
  it('registers the expected codemem MCP tool names', () => {
    const tools = createCodememMcpTools(() => ({} as AgentLspFacade));

    expect(tools.map((tool) => tool.name)).toEqual([
      'find_symbol',
      'find_references',
      'document_symbols',
      'workspace_symbols',
      'call_hierarchy',
      'find_implementations',
      'hover',
      'diagnostics',
    ]);
  });
});
