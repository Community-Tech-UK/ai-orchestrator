import { describe, expect, it, vi } from 'vitest';

import type { CliAdapter, UnifiedSpawnOptions } from '../../../cli/adapters/adapter-factory';
import { InstanceSpawnPreflightChain } from '../instance-spawn-preflight-chain';

function makeSpawnOptions(overrides: Partial<UnifiedSpawnOptions> = {}): UnifiedSpawnOptions {
  return {
    sessionId: 'session-1',
    workingDirectory: '/tmp/project',
    mcpConfig: ['local-mcp.json'],
    browserGatewayMcp: {
      aioMcpCliPath: '/tmp/aio-mcp',
      socketPath: '/tmp/browser.sock',
      instanceId: 'instance-1',
    },
    ...overrides,
  };
}

function makeDeps() {
  return {
    consumeWarmAdapter: vi.fn(),
    assertLocalModelRuntimeAvailable: vi.fn().mockResolvedValue(undefined),
    warmCodememWorkspace: vi.fn().mockResolvedValue(undefined),
  };
}

describe('InstanceSpawnPreflightChain', () => {
  it('returns an eligible warm adapter without running fresh-spawn preparation', async () => {
    const deps = makeDeps();
    const adapter = { getName: () => 'claude' } as CliAdapter;
    deps.consumeWarmAdapter.mockReturnValue(adapter);
    const chain = new InstanceSpawnPreflightChain(deps);

    const result = await chain.prepare({
      config: { workingDirectory: '/tmp/project', provider: 'claude' },
      instance: { workingDirectory: '/tmp/project', bareMode: false },
      provider: 'claude',
      spawnOptions: makeSpawnOptions({ browserGatewayMcp: undefined }),
    });

    expect(result).toEqual({ kind: 'warm', adapter });
    expect(deps.consumeWarmAdapter).toHaveBeenCalledWith('claude', '/tmp/project');
    expect(deps.assertLocalModelRuntimeAvailable).not.toHaveBeenCalled();
    expect(deps.warmCodememWorkspace).not.toHaveBeenCalled();
  });

  it('forces a fresh local preflight for resume and warms the workspace', async () => {
    const deps = makeDeps();
    const chain = new InstanceSpawnPreflightChain(deps);
    const spawnOptions = makeSpawnOptions({ resume: true, browserGatewayMcp: undefined });

    const result = await chain.prepare({
      config: { workingDirectory: '/tmp/project', provider: 'claude', resume: true },
      instance: { workingDirectory: '/tmp/project', bareMode: false },
      provider: 'claude',
      spawnOptions,
    });

    expect(result).toEqual({
      kind: 'fresh',
      executionLocation: { type: 'local' },
      spawnOptions,
    });
    expect(deps.consumeWarmAdapter).not.toHaveBeenCalled();
    expect(deps.assertLocalModelRuntimeAvailable).toHaveBeenCalledWith(undefined);
    expect(deps.warmCodememWorkspace).toHaveBeenCalledWith('/tmp/project');
  });

  it('validates remote local-model targets and removes coordinator-only MCP options', async () => {
    const deps = makeDeps();
    const chain = new InstanceSpawnPreflightChain(deps);
    const target = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-1/ollama/ollama/qwen',
      nodeId: 'node-1',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen',
    };

    const result = await chain.prepare({
      config: {
        workingDirectory: '/tmp/project',
        provider: 'claude',
        modelRuntimeTarget: target,
      },
      instance: { workingDirectory: '/tmp/project', bareMode: false },
      provider: 'claude',
      spawnOptions: makeSpawnOptions({ modelRuntimeTarget: target }),
    });

    expect(result).toMatchObject({
      kind: 'fresh',
      executionLocation: { type: 'remote', nodeId: 'node-1' },
      spawnOptions: { mcpConfig: [], browserGatewayMcp: undefined },
    });
    expect(deps.assertLocalModelRuntimeAvailable).toHaveBeenCalledWith(target);
    expect(deps.warmCodememWorkspace).not.toHaveBeenCalled();
  });

  it('does not consume a Cursor warm process when an explicit model is configured', async () => {
    const deps = makeDeps();
    const chain = new InstanceSpawnPreflightChain(deps);

    const result = await chain.prepare({
      config: { workingDirectory: '/tmp/project', provider: 'cursor' },
      instance: { workingDirectory: '/tmp/project', bareMode: false },
      provider: 'cursor',
      spawnOptions: makeSpawnOptions({ model: 'composer-2.5', browserGatewayMcp: undefined }),
    });

    expect(result.kind).toBe('fresh');
    expect(deps.consumeWarmAdapter).not.toHaveBeenCalled();
  });
});
