import { describe, expect, it, vi } from 'vitest';
import { createCodememMcpTools } from '../mcp-tools';
import type { AgentLspFacade } from '../agent-lsp-facade';

describe('createCodememMcpTools', () => {
  it('lazily warms the exact worktree when a symbol-search tool is called', async () => {
    const findSymbol = vi.fn(() => []);
    const warm = vi.fn(async () => undefined);
    const tools = createCodememMcpTools(() => ({ findSymbol } as unknown as AgentLspFacade), warm);
    await tools.find(tool => tool.name === 'find_symbol')!.handler({ workspacePath: '/repo/.worktrees/queue/job', name: 'needle' });
    expect(warm).toHaveBeenCalledExactlyOnceWith('/repo/.worktrees/queue/job');
    expect(warm.mock.invocationCallOrder[0]).toBeLessThan(findSymbol.mock.invocationCallOrder[0]);
    expect(findSymbol).toHaveBeenCalledWith('needle', expect.objectContaining({ workspacePath: '/repo/.worktrees/queue/job' }));
  });
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
