import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';

function stubClient(impl: OrchestratorToolsRpcClientLike['call']): OrchestratorToolsRpcClientLike {
  return { call: impl };
}

describe('createOrchestratorToolsForwarderTools', () => {
  it('exposes the orchestrator MCP tools', () => {
    const tools = createOrchestratorToolsForwarderTools(stubClient(async () => null));
    expect(tools.map((t) => t.name)).toEqual([
      'git_batch_pull',
      'list_remote_nodes',
      'run_on_node',
      'read_node_output',
      'create_automation',
      'list_automations',
    ]);
  });

  it('forwards create_automation invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ id: 'auto-1', name: 'Daily sweep' }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'create_automation',
    );

    const result = await tool!.handler({ name: 'Daily sweep', prompt: 'Review PRs', cron: '0 9 * * 1-5' });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.create_automation', {
      name: 'Daily sweep',
      prompt: 'Review PRs',
      cron: '0 9 * * 1-5',
    });
    expect(result).toEqual({ id: 'auto-1', name: 'Daily sweep' });
  });

  it('forwards list_automations invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ count: 0, automations: [] }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'list_automations',
    );

    const result = await tool!.handler({});

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.list_automations', {});
    expect(result).toEqual({ count: 0, automations: [] });
  });

  it('forwards list_remote_nodes invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ connectedCount: 1, totalCount: 1, nodes: [] }));
    const listTool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'list_remote_nodes',
    );

    const result = await listTool!.handler({});

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.list_remote_nodes', {});
    expect(result).toEqual({ connectedCount: 1, totalCount: 1, nodes: [] });
  });

  it('forwards read_node_output invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ status: 'idle', done: true, messages: [] }));
    const readTool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'read_node_output',
    );

    const result = await readTool!.handler({ instanceId: 'inst-1', limit: 10 });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.read_node_output', {
      instanceId: 'inst-1',
      limit: 10,
    });
    expect(result).toEqual({ status: 'idle', done: true, messages: [] });
  });

  it('rejects malformed read_node_output args before contacting the parent', async () => {
    const call = vi.fn();
    const readTool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'read_node_output',
    );

    await expect(readTool!.handler(null)).rejects.toThrow(/must be an object/);
    await expect(readTool!.handler('string')).rejects.toThrow(/must be an object/);
    await expect(readTool!.handler([])).rejects.toThrow(/must be an object/);
    expect(call).not.toHaveBeenCalled();
  });

  it('forwards run_on_node invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({
      instanceId: 'inst-1',
      nodeId: 'node-1',
    }));
    const runTool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'run_on_node',
    );

    const result = await runTool!.handler({ node: 'windows-pc', prompt: 'run the tests' });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.run_on_node', {
      node: 'windows-pc',
      prompt: 'run the tests',
    });
    expect(result).toEqual({ instanceId: 'inst-1', nodeId: 'node-1' });
  });

  it('rejects malformed run_on_node args before contacting the parent', async () => {
    const call = vi.fn();
    const runTool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'run_on_node',
    );

    await expect(runTool!.handler(null)).rejects.toThrow(/must be an object/);
    await expect(runTool!.handler('string')).rejects.toThrow(/must be an object/);
    await expect(runTool!.handler([])).rejects.toThrow(/must be an object/);
    expect(call).not.toHaveBeenCalled();
  });

  it('forwards tool invocations to the RPC client with the canonical method name', async () => {
    const call = vi.fn(async () => ({ summary: 'ok' }));
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
