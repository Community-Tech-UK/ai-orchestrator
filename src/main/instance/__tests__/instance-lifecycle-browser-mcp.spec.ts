import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/ai-orchestrator',
    isPackaged: false,
  },
}));

const browserGatewayMocks = vi.hoisted(() => ({
  buildBrowserGatewayMcpConfigJson: vi.fn(() => '{"mcpServers":{"browser-gateway":{}}}'),
  getBrowserGatewayRpcSocketPath: vi.fn(() => '/tmp/browser-gateway.sock'),
}));

const mcpInjectionMocks = vi.hoisted(() => ({
  buildBundle: vi.fn(() => ({
    configPaths: [],
    inlineConfigs: ['{"mcpServers":{"orchestrator-test":{}}}'],
  })),
}));

vi.mock('../../browser-gateway', () => ({
  buildBrowserGatewayMcpConfigJson: browserGatewayMocks.buildBrowserGatewayMcpConfigJson,
  getBrowserGatewayRpcSocketPath: browserGatewayMocks.getBrowserGatewayRpcSocketPath,
}));

vi.mock('../../mcp/mcp-multi-provider-singletons', () => ({
  getOrchestratorInjectionReader: () => ({
    buildBundle: mcpInjectionMocks.buildBundle,
  }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { InstanceLifecycleManager } from '../instance-lifecycle';

describe('InstanceLifecycleManager Browser Gateway MCP config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds Browser Gateway MCP config for local instances when the RPC socket is available', () => {
    const manager = makeManager();

    const configs = manager.getMcpConfig({ type: 'local' }, 'instance-browser');

    expect(configs).toContain('{"mcpServers":{"browser-gateway":{}}}');
    expect(browserGatewayMocks.buildBrowserGatewayMcpConfigJson).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: '/tmp/browser-gateway.sock',
        instanceId: 'instance-browser',
      }),
    );
  });

  it('does not add local Browser Gateway config for remote instances', () => {
    const manager = makeManager();

    expect(configsForRemote(manager)).toEqual([]);
    expect(browserGatewayMocks.buildBrowserGatewayMcpConfigJson).not.toHaveBeenCalled();
  });

  it('adds Orchestrator-scoped inline MCP configs for supported local providers', () => {
    const manager = makeManager();

    const configs = manager.getMcpConfig({ type: 'local' }, 'instance-browser', 'claude');

    expect(configs).toContain('{"mcpServers":{"orchestrator-test":{}}}');
    expect(mcpInjectionMocks.buildBundle).toHaveBeenCalledWith('claude');
  });

  it('skips Orchestrator-scoped configs for providers that do not consume mcpConfig', () => {
    const manager = makeManager();

    manager.getMcpConfig({ type: 'local' }, 'instance-browser', 'codex');

    expect(mcpInjectionMocks.buildBundle).not.toHaveBeenCalled();
  });

  it('skips Orchestrator-scoped configs for unsupported providers', () => {
    const manager = makeManager();

    manager.getMcpConfig({ type: 'local' }, 'instance-browser', 'cursor');

    expect(mcpInjectionMocks.buildBundle).not.toHaveBeenCalled();
  });
});

function makeManager(): {
  getMcpConfig(
    executionLocation?: { type: 'local' } | { type: 'remote'; nodeId: string },
    instanceId?: string,
    provider?: string,
  ): string[];
  settings: { getAll: () => { codememEnabled: boolean } };
} {
  const manager = Object.create(InstanceLifecycleManager.prototype) as {
    getMcpConfig(
      executionLocation?: { type: 'local' } | { type: 'remote'; nodeId: string },
      instanceId?: string,
      provider?: string,
    ): string[];
    settings: { getAll: () => { codememEnabled: boolean } };
  };
  manager.settings = { getAll: () => ({ codememEnabled: false }) };
  return manager;
}

function configsForRemote(manager: ReturnType<typeof makeManager>): string[] {
  return manager.getMcpConfig({ type: 'remote', nodeId: 'node-1' }, 'instance-browser');
}
