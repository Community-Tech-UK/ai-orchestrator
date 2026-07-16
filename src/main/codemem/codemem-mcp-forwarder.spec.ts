import { describe, expect, it, vi } from 'vitest';
import { createCodememForwarderTools } from './codemem-mcp-forwarder';
import type { CodememRpcClientLike } from './codemem-rpc-client';

function stubClient(impl: CodememRpcClientLike['call']): CodememRpcClientLike {
  return { call: impl };
}

describe('createCodememForwarderTools', () => {
  it('exposes all 8 codemem MCP tools, in the same order/names as before', () => {
    const tools = createCodememForwarderTools(stubClient(async () => null));
    expect(tools.map((t) => t.name)).toEqual([
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

  it('forwards each MCP tool to its matching RPC method', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const tools = createCodememForwarderTools(stubClient(call));

    const fixtures: Array<{ tool: string; args: Record<string, unknown>; expectedMethod: string }> = [
      { tool: 'find_symbol', args: { name: 'x' }, expectedMethod: 'codemem.find_symbol' },
      { tool: 'find_references', args: { symbolId: 's:1' }, expectedMethod: 'codemem.find_references' },
      { tool: 'document_symbols', args: { path: '/r/x.ts' }, expectedMethod: 'codemem.document_symbols' },
      { tool: 'workspace_symbols', args: { query: 'q' }, expectedMethod: 'codemem.workspace_symbols' },
      { tool: 'call_hierarchy', args: { symbolId: 's:1', direction: 'incoming' }, expectedMethod: 'codemem.call_hierarchy' },
      { tool: 'find_implementations', args: { symbolId: 's:1' }, expectedMethod: 'codemem.find_implementations' },
      { tool: 'hover', args: { symbolId: 's:1' }, expectedMethod: 'codemem.hover' },
      { tool: 'diagnostics', args: { path: '/r/x.ts' }, expectedMethod: 'codemem.diagnostics' },
    ];

    for (const f of fixtures) {
      call.mockClear();
      const tool = tools.find((t) => t.name === f.tool)!;
      await tool.handler(f.args);
      expect(call, `${f.tool} -> ${f.expectedMethod}`).toHaveBeenCalledWith(f.expectedMethod, f.args);
    }
  });

  it('rejects non-object args before contacting the parent', async () => {
    const call = vi.fn();
    const [findSymbol] = createCodememForwarderTools(stubClient(call));
    await expect(findSymbol!.handler(null as unknown as Record<string, unknown>)).rejects.toThrow(/must be an object/);
    await expect(findSymbol!.handler('str' as unknown as Record<string, unknown>)).rejects.toThrow(/must be an object/);
    await expect(findSymbol!.handler([] as unknown as Record<string, unknown>)).rejects.toThrow(/must be an object/);
    expect(call).not.toHaveBeenCalled();
  });

  it('surfaces RPC client errors verbatim', async () => {
    const [findSymbol] = createCodememForwarderTools(
      stubClient(async () => {
        throw new Error('boom from parent');
      }),
    );
    await expect(findSymbol!.handler({ name: 'x' })).rejects.toThrow(/boom from parent/);
  });
});
