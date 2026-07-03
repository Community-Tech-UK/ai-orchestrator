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
      'terminate_node_instance',
      'list_settings',
      'get_setting',
      'set_setting',
      'reset_setting',
      'update_node_config',
      'create_automation',
      'list_automations',
      'delete_automation',
      'update_automation',
      'postpone_automation',
    ]);
  });

  it('forwards set_setting invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ ok: true, key: 'theme' }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'set_setting',
    );

    const result = await tool!.handler({ key: 'theme', value: 'light' });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.settings.set', {
      key: 'theme',
      value: 'light',
    });
    expect(result).toEqual({ ok: true, key: 'theme' });
  });

  it('describes set_setting JSON values without suggesting secret endpoint arrays are writable', () => {
    const tool = createOrchestratorToolsForwarderTools(stubClient(async () => null)).find(
      (t) => t.name === 'set_setting',
    );

    expect(tool?.description).toContain('JSON-backed settings accept real objects');
    expect(tool?.description).not.toContain('arrays/objects');
  });

  it('forwards update_node_config invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'update_node_config',
    );

    await tool!.handler({ nodeId: 'windows-pc', extensionRelay: { enabled: true } });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.node_config.update', {
      nodeId: 'windows-pc',
      extensionRelay: { enabled: true },
    });
  });

  it('forwards delete_automation invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ id: 'auto-1', name: 'Daily sweep', deleted: true, detachedInstanceIds: [] }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'delete_automation',
    );

    const result = await tool!.handler({ id: 'auto-1' });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.delete_automation', { id: 'auto-1' });
    expect(result).toEqual({ id: 'auto-1', name: 'Daily sweep', deleted: true, detachedInstanceIds: [] });
  });

  it('forwards update_automation invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ id: 'auto-1' }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'update_automation',
    );

    await tool!.handler({ id: 'auto-1', enabled: false });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.update_automation', {
      id: 'auto-1',
      enabled: false,
    });
  });

  it('forwards postpone_automation invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({ id: 'auto-1' }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'postpone_automation',
    );

    await tool!.handler({ id: 'auto-1', delayMinutes: 60 });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.postpone_automation', {
      id: 'auto-1',
      delayMinutes: 60,
    });
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

  it('forwards terminate_node_instance invocations with the canonical method name', async () => {
    const call = vi.fn(async () => ({
      terminated: [{ instanceId: 'inst-1' }],
      skipped: [],
    }));
    const tool = createOrchestratorToolsForwarderTools(stubClient(call)).find(
      (t) => t.name === 'terminate_node_instance',
    );

    const result = await tool!.handler({ allIdle: true, node: 'noahlaptop' });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('orchestrator_tools.terminate_node_instance', {
      allIdle: true,
      node: 'noahlaptop',
    });
    expect(result).toEqual({ terminated: [{ instanceId: 'inst-1' }], skipped: [] });
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
