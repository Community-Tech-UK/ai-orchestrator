import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 5+ wiring: SpawnConfigBuilder (extracted from instance-lifecycle)
// resolves the `aio-mcp` SEA binary path + the parent's RPC socket paths and
// passes them to every MCP config builder. The tests below pin that wiring —
// they would fail under the old `process.execPath` + script-path scheme
// (which silently broke packaged builds with the RunAsNode fuse off).
const FAKE_AIO_MCP_PATH =
  '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const FAKE_ORCHESTRATOR_TOOLS_SOCKET = '/tmp/harness/ot-test.sock';
const FAKE_CODEMEM_SOCKET = '/tmp/harness/cm-test.sock';
const FAKE_BROWSER_GATEWAY_SOCKET = '/tmp/browser-gateway.sock';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/harness',
    isPackaged: false,
  },
}));

const browserGatewayMocks = vi.hoisted(() => ({
  buildBrowserGatewayMcpConfigJson: vi.fn(() => '{"mcpServers":{"browser-gateway":{}}}'),
  getBrowserGatewayRpcSocketPath: vi.fn(() => '/tmp/browser-gateway.sock'),
  buildChromeDevtoolsMcpConfigJson: vi.fn(() => '{"mcpServers":{"chrome-devtools":{}}}'),
  resolveChromeDevtoolsBrowserUrl: vi.fn(() => 'http://127.0.0.1:31234'),
}));

const mcpInjectionMocks = vi.hoisted(() => ({
  buildBundle: vi.fn(() => ({
    configPaths: [],
    inlineConfigs: ['{"mcpServers":{"orchestrator-test":{}}}'],
  })),
}));

const orchestratorToolsMocks = vi.hoisted(() => ({
  buildOrchestratorToolsMcpConfig: vi.fn(() => '{"mcpServers":{"orchestrator":{}}}'),
  getOrchestratorToolsRpcSocketPath: vi.fn(() => '/tmp/harness/ot-test.sock'),
}));

const codememMocks = vi.hoisted(() => ({
  buildCodememMcpConfig: vi.fn(() => '{"mcpServers":{"codemem":{}}}'),
  getCodememRpcSocketPath: vi.fn(() => '/tmp/harness/cm-test.sock'),
}));

const aioMcpPathMocks = vi.hoisted(() => ({
  resolveAioMcpCliPath: vi.fn(),
}));

vi.mock('../../browser-gateway', () => ({
  buildBrowserGatewayMcpConfigJson: browserGatewayMocks.buildBrowserGatewayMcpConfigJson,
  getBrowserGatewayRpcSocketPath: browserGatewayMocks.getBrowserGatewayRpcSocketPath,
  buildChromeDevtoolsMcpConfigJson: browserGatewayMocks.buildChromeDevtoolsMcpConfigJson,
  resolveChromeDevtoolsBrowserUrl: browserGatewayMocks.resolveChromeDevtoolsBrowserUrl,
}));

vi.mock('../../mcp/mcp-multi-provider-singletons', () => ({
  getOrchestratorInjectionReader: () => ({
    buildBundle: mcpInjectionMocks.buildBundle,
  }),
}));

vi.mock('../../mcp/orchestrator-tools-mcp-config', () => ({
  buildOrchestratorToolsMcpConfig: orchestratorToolsMocks.buildOrchestratorToolsMcpConfig,
}));

vi.mock('../../mcp/orchestrator-tools-rpc-server', () => ({
  getOrchestratorToolsRpcSocketPath: orchestratorToolsMocks.getOrchestratorToolsRpcSocketPath,
}));

vi.mock('../../codemem/mcp-config', () => ({
  buildCodememMcpConfig: codememMocks.buildCodememMcpConfig,
}));

vi.mock('../../codemem/codemem-rpc-server', () => ({
  getCodememRpcSocketPath: codememMocks.getCodememRpcSocketPath,
}));

vi.mock('../../util/aio-mcp-cli-path', () => ({
  resolveAioMcpCliPath: aioMcpPathMocks.resolveAioMcpCliPath,
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import type { SettingsManager } from '../../core/config/settings-manager';
import { SpawnConfigBuilder } from '../lifecycle/spawn-config-builder';

describe('SpawnConfigBuilder — Browser Gateway MCP config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aioMcpPathMocks.resolveAioMcpCliPath.mockReturnValue(FAKE_AIO_MCP_PATH);
    orchestratorToolsMocks.getOrchestratorToolsRpcSocketPath.mockReturnValue(
      FAKE_ORCHESTRATOR_TOOLS_SOCKET,
    );
    codememMocks.getCodememRpcSocketPath.mockReturnValue(FAKE_CODEMEM_SOCKET);
    browserGatewayMocks.getBrowserGatewayRpcSocketPath.mockReturnValue(
      FAKE_BROWSER_GATEWAY_SOCKET,
    );
  });

  it('adds Browser Gateway MCP config for local instances when the RPC socket is available', () => {
    const builder = makeBuilder();

    const configs = builder.getMcpConfig({ type: 'local' }, 'instance-browser');

    expect(configs).toContain('{"mcpServers":{"browser-gateway":{}}}');
    expect(browserGatewayMocks.buildBrowserGatewayMcpConfigJson).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: FAKE_BROWSER_GATEWAY_SOCKET,
        instanceId: 'instance-browser',
      }),
    );
  });

  it('does not add local Browser Gateway config for remote instances', () => {
    const builder = makeBuilder();

    expect(configsForRemote(builder)).toEqual([]);
    expect(browserGatewayMocks.buildBrowserGatewayMcpConfigJson).not.toHaveBeenCalled();
  });

  it('adds chrome-devtools attach config when attach is enabled with a profile id', () => {
    const builder = makeBuilder({
      chromeDevtoolsAttachEnabled: true,
      chromeDevtoolsAttachProfileId: 'profile-attach',
    });

    const configs = builder.getMcpConfig({ type: 'local' }, 'instance-browser', 'claude');

    expect(configs).toContain('{"mcpServers":{"chrome-devtools":{}}}');
    expect(browserGatewayMocks.resolveChromeDevtoolsBrowserUrl).toHaveBeenCalledWith('profile-attach');
    expect(browserGatewayMocks.buildChromeDevtoolsMcpConfigJson).toHaveBeenCalledWith({
      browserUrl: 'http://127.0.0.1:31234',
    });
  });

  it('omits chrome-devtools attach config when attach is disabled', () => {
    const builder = makeBuilder({ chromeDevtoolsAttachEnabled: false });

    const configs = builder.getMcpConfig({ type: 'local' }, 'instance-browser', 'claude');

    expect(configs).not.toContain('{"mcpServers":{"chrome-devtools":{}}}');
    expect(browserGatewayMocks.buildChromeDevtoolsMcpConfigJson).not.toHaveBeenCalled();
  });

  it('omits chrome-devtools attach config when enabled but no profile id is set', () => {
    const builder = makeBuilder({
      chromeDevtoolsAttachEnabled: true,
      chromeDevtoolsAttachProfileId: '   ',
    });

    builder.getMcpConfig({ type: 'local' }, 'instance-browser', 'claude');

    expect(browserGatewayMocks.buildChromeDevtoolsMcpConfigJson).not.toHaveBeenCalled();
  });

  it('does not add chrome-devtools attach config for remote instances', () => {
    const builder = makeBuilder({
      chromeDevtoolsAttachEnabled: true,
      chromeDevtoolsAttachProfileId: 'profile-attach',
    });

    builder.getMcpConfig({ type: 'remote', nodeId: 'node-1' }, 'instance-browser', 'claude');

    expect(browserGatewayMocks.buildChromeDevtoolsMcpConfigJson).not.toHaveBeenCalled();
  });

  it('adds Orchestrator-scoped inline MCP configs for supported local providers', () => {
    const builder = makeBuilder();

    const configs = builder.getMcpConfig({ type: 'local' }, 'instance-browser', 'claude');

    expect(configs).toContain('{"mcpServers":{"orchestrator-test":{}}}');
    expect(mcpInjectionMocks.buildBundle).toHaveBeenCalledWith('claude');
  });

  it('skips Orchestrator-scoped configs for providers that do not consume mcpConfig', () => {
    const builder = makeBuilder();

    builder.getMcpConfig({ type: 'local' }, 'instance-browser', 'codex');

    expect(mcpInjectionMocks.buildBundle).not.toHaveBeenCalled();
  });

  it('skips Orchestrator-scoped configs for unsupported providers', () => {
    const builder = makeBuilder();

    builder.getMcpConfig({ type: 'local' }, 'instance-browser', 'cursor');

    expect(mcpInjectionMocks.buildBundle).not.toHaveBeenCalled();
  });
});

// These tests pin the wiring between the spawn-config builder and the SEA
// dispatcher + parent-side RPC sockets. The original regression was that
// `instance-lifecycle.ts` was passing `process.execPath` (the foreground
// GUI binary) directly to the MCP config builders — yesterday's helper-
// binary fix masked the visible dock-icon flash but the underlying MCP
// servers silently failed under the `RunAsNode=false` Electron fuse.
//
// After Phase 5 each builder receives:
//   aioMcpCliPath: <resolved SEA binary path>
//   socketPath:    <parent-side RPC socket path>
//   instanceId:    <auth handle>
//
// Mocking the resolver + socket-path getters lets us assert each builder
// receives the right combination, independent of what's installed on the
// vitest host machine.
describe('SpawnConfigBuilder — MCP configs route through the aio-mcp SEA + RPC sockets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aioMcpPathMocks.resolveAioMcpCliPath.mockReturnValue(FAKE_AIO_MCP_PATH);
    orchestratorToolsMocks.getOrchestratorToolsRpcSocketPath.mockReturnValue(
      FAKE_ORCHESTRATOR_TOOLS_SOCKET,
    );
    codememMocks.getCodememRpcSocketPath.mockReturnValue(FAKE_CODEMEM_SOCKET);
    browserGatewayMocks.getBrowserGatewayRpcSocketPath.mockReturnValue(
      FAKE_BROWSER_GATEWAY_SOCKET,
    );
  });

  it('passes the SEA path + browser-gateway socket to buildBrowserGatewayMcpConfigJson', () => {
    const builder = makeBuilder();

    builder.getMcpConfig({ type: 'local' }, 'instance-browser');

    expect(browserGatewayMocks.buildBrowserGatewayMcpConfigJson).toHaveBeenCalledWith({
      aioMcpCliPath: FAKE_AIO_MCP_PATH,
      socketPath: FAKE_BROWSER_GATEWAY_SOCKET,
      instanceId: 'instance-browser',
    });
  });

  it('passes the SEA path + orchestrator-tools socket to buildOrchestratorToolsMcpConfig', () => {
    const builder = makeBuilder();

    builder.getMcpConfig({ type: 'local' }, 'instance-tools', 'claude');

    expect(orchestratorToolsMocks.buildOrchestratorToolsMcpConfig).toHaveBeenCalledWith({
      aioMcpCliPath: FAKE_AIO_MCP_PATH,
      socketPath: FAKE_ORCHESTRATOR_TOOLS_SOCKET,
      instanceId: 'instance-tools',
    });
  });

  it('passes the SEA path + codemem socket to buildCodememMcpConfig when codemem is enabled', () => {
    const builder = makeBuilder({ codememEnabled: true });

    builder.getMcpConfig({ type: 'local' }, 'instance-codemem');

    expect(codememMocks.buildCodememMcpConfig).toHaveBeenCalledWith({
      aioMcpCliPath: FAKE_AIO_MCP_PATH,
      socketPath: FAKE_CODEMEM_SOCKET,
      instanceId: 'instance-codemem',
    });
  });

  it('omits orchestrator-tools when its socket is unavailable, even with the SEA present', () => {
    orchestratorToolsMocks.getOrchestratorToolsRpcSocketPath.mockReturnValue(null);
    const builder = makeBuilder();

    builder.getMcpConfig({ type: 'local' }, 'instance-x', 'claude');

    expect(orchestratorToolsMocks.buildOrchestratorToolsMcpConfig).not.toHaveBeenCalled();
  });

  it('omits codemem when the SEA binary is missing, even with the socket up', () => {
    aioMcpPathMocks.resolveAioMcpCliPath.mockReturnValue(null);
    const builder = makeBuilder({ codememEnabled: true });

    builder.getMcpConfig({ type: 'local' }, 'instance-x');

    expect(codememMocks.buildCodememMcpConfig).not.toHaveBeenCalled();
  });

  it('does not even try to resolve the SEA path for remote instances (no spawn happens)', () => {
    const builder = makeBuilder({ codememEnabled: true });

    builder.getMcpConfig({ type: 'remote', nodeId: 'node-1' }, 'instance-remote');

    expect(aioMcpPathMocks.resolveAioMcpCliPath).not.toHaveBeenCalled();
    expect(orchestratorToolsMocks.getOrchestratorToolsRpcSocketPath).not.toHaveBeenCalled();
    expect(codememMocks.getCodememRpcSocketPath).not.toHaveBeenCalled();
  });
});

function makeBuilder(
  overrides: {
    codememEnabled?: boolean;
    chromeDevtoolsAttachEnabled?: boolean;
    chromeDevtoolsAttachProfileId?: string;
  } = {},
): SpawnConfigBuilder {
  const settings = {
    getAll: () => ({
      codememEnabled: overrides.codememEnabled ?? false,
      chromeDevtoolsAttachEnabled: overrides.chromeDevtoolsAttachEnabled ?? false,
      chromeDevtoolsAttachProfileId: overrides.chromeDevtoolsAttachProfileId ?? '',
    }),
    get: () => undefined,
  } as unknown as SettingsManager;
  return new SpawnConfigBuilder({ settings });
}

function configsForRemote(builder: SpawnConfigBuilder): string[] {
  return builder.getMcpConfig({ type: 'remote', nodeId: 'node-1' }, 'instance-browser');
}
