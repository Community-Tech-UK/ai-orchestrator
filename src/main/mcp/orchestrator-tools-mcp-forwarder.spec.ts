import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';

function stubClient(impl: OrchestratorToolsRpcClientLike['call']): OrchestratorToolsRpcClientLike {
  return { call: impl };
}

describe('createOrchestratorToolsForwarderTools', () => {
  it('exposes git_batch_pull as the only MCP tool', () => {
    const tools = createOrchestratorToolsForwarderTools(stubClient(async () => null));
    expect(tools.map((t) => t.name)).toEqual(['git_batch_pull']);
  });

  it('forwards tool invocations to the RPC client with the canonical method name', async () => {
    const call = vi.fn(async (_method: string, _args: Record<string, unknown>) => ({ summary: 'ok' }));
    const [pullTool] = createOrchestratorToolsForwarderTools(stubClient(call));

    const result = await pullTool!.handler({ root: '/repo', concurrency: 2 });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.git_batch_pull', {
      root: '/repo',
      concurrency: 2,
    });
    expect(result).toEqual({ summary: 'ok' });
  });

  it('rejects malformed args before contacting the parent', async () => {
    const call = vi.fn();
    const [pullTool] = createOrchestratorToolsForwarderTools(stubClient(call));

    // null / undefined / primitive args should be rejected client-side rather
    // than crossing the wire and consuming a parent rate-limit slot.
    await expect(pullTool!.handler(null)).rejects.toThrow(/must be an object/);
    await expect(pullTool!.handler('string')).rejects.toThrow(/must be an object/);
    await expect(pullTool!.handler([])).rejects.toThrow(/must be an object/);
    expect(call).not.toHaveBeenCalled();
  });

  it('surfaces RPC client errors verbatim so the forwarder turns them into JSON-RPC errors', async () => {
    const [pullTool] = createOrchestratorToolsForwarderTools(
      stubClient(async () => {
        throw new Error('parent unavailable');
      }),
    );

    await expect(pullTool!.handler({ root: '/repo' })).rejects.toThrow(/parent unavailable/);
  });
});
