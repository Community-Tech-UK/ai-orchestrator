/**
 * Schema-size telemetry must report the tool surface the final Claude seam
 * (`configureClaudeNativeSearchMcp`) settles on: with Claude's own tool search
 * on, Harness lists its MCP tools eagerly, so "deferred" would be misleading.
 * The resolvers are the real ones; only sockets, the CLI path and the logger
 * are stubbed. Settings fixtures use the real shape of Claude's
 * `settings.json` (`env` holds string values such as `ENABLE_TOOL_SEARCH`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/harness', isPackaged: false } }));

const loggerMocks = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock('../../logging/logger', () => ({ getLogger: () => loggerMocks }));

vi.mock('../../browser-gateway', async () => {
  const config = await vi.importActual<typeof import('../../browser-gateway/browser-mcp-config')>(
    '../../browser-gateway/browser-mcp-config',
  );
  return {
    resolveBrowserGatewayToolMode: config.resolveBrowserGatewayToolMode,
    buildBrowserGatewayMcpConfigJson: vi.fn(() => '{}'),
    buildChromeDevtoolsMcpConfigJson: vi.fn(() => '{}'),
    resolveChromeDevtoolsBrowserUrl: vi.fn(() => 'http://127.0.0.1:1'),
    getBrowserGatewayRpcSocketPath: vi.fn(() => '/tmp/browser-gateway.sock'),
    getBrowserGatewayRpcInstanceCapability: vi.fn(() => 'PLACEHOLDER_CAPABILITY'),
    createBrowserMcpTools: vi.fn(() => [{ name: 'browser.full', inputSchema: {} }]),
    createDeferredBrowserMcpTools: vi.fn(() => [{ name: 'browser.visible', inputSchema: {}, hidden: false }]),
    measureToolSchemaBytes: vi.fn((tools: unknown[]) => tools.length * 100),
  };
});
vi.mock('../../browser-gateway/browser-forwarder-log-retention', () => ({
  maybePruneBrowserForwarderLogs: vi.fn(() => ({ removed: 0 })),
}));
vi.mock('../../desktop-gateway', () => ({
  buildComputerUseMcpConfigJson: vi.fn(() => '{}'),
  getDesktopGatewayRpcSocketPath: vi.fn(() => null),
  getDesktopGatewayInjectionState: vi.fn(() => ({ supported: false, enabled: false, actionToolsHealthy: false })),
  DESKTOP_DEGRADED_TOOL_NAMES: [],
}));
vi.mock('../../mcp/mcp-multi-provider-singletons', () => ({
  getOrchestratorInjectionReader: () => ({ buildBundle: () => ({ configPaths: [], inlineConfigs: [] }) }),
  getWorkspaceMcpConnectorRepository: () => ({}),
}));
vi.mock('../../mcp/orchestrator-tools-mcp-forwarder', () => ({
  createOrchestratorToolsForwarderTools: () => [{ name: 'list_remote_nodes', inputSchema: {} }],
}));
vi.mock('../../mcp/orchestrator-mcp-deferral', () => ({
  createDeferredOrchestratorTools: (tools: unknown[]) => tools,
  measureOrchestratorToolSchemaBytes: (tools: unknown[]) => tools.length * 100,
}));
vi.mock('../../mcp/orchestrator-mcp-stable-tools', () => ({ createStableOrchestratorTools: (tools: unknown[]) => tools }));
vi.mock('../../mcp/orchestrator-tools-rpc-server', () => ({
  getOrchestratorToolsRpcSocketPath: () => '/tmp/harness/ot-test.sock',
  getOrchestratorToolsRpcInstanceCapability: () => 'PLACEHOLDER_CAPABILITY',
}));
vi.mock('../../codemem/mcp-config', () => ({ buildCodememMcpConfig: vi.fn(() => '{}') }));
vi.mock('../../codemem/codemem-rpc-server', () => ({ getCodememRpcSocketPath: () => null }));
vi.mock('../../util/aio-mcp-cli-path', () => ({ resolveAioMcpCliPath: () => '/tmp/harness/aio-mcp' }));

import type { SettingsManager } from '../../core/config/settings-manager';
import { SpawnConfigBuilder } from './spawn-config-builder';

function makeBuilder(): SpawnConfigBuilder {
  const settings = {
    getAll: () => ({
      browserMcpToolDeferral: true,
      orchestratorMcpToolDeferral: true,
      interSessionMessaging: { enabled: false },
    }),
    get: () => undefined,
  } as unknown as SettingsManager;
  return new SpawnConfigBuilder({ settings });
}

const loggedMessages = (): string[] => loggerMocks.info.mock.calls.map(call => String(call[0]));

describe('SpawnConfigBuilder schema telemetry follows Claude native tool search', () => {
  let configDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    configDir = mkdtempSync(join(tmpdir(), 'aio-native-search-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('ENABLE_TOOL_SEARCH', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  const writeClaudeSettingsEnv = (env: Record<string, string>): void =>
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env }));

  it('reports both Claude surfaces eager when the settings env turns Claude tool search on', () => {
    writeClaudeSettingsEnv({ ENABLE_TOOL_SEARCH: 'auto:0' });
    const builder = makeBuilder();

    const orchestrator = builder.getMcpConfig({ type: 'local' }, 'inst-1', 'claude');
    const browser = builder.getBrowserGatewayMcpOptions({ type: 'local' }, 'inst-1', 'claude');

    expect(orchestrator).toBeDefined();
    expect(loggedMessages()).toContain('Orchestrator tool schemas injected eagerly');
    expect(loggedMessages()).toContain('Browser gateway tool schemas injected eagerly');
    expect(loggedMessages()).not.toContain('Orchestrator tool schemas deferred');
    expect(loggedMessages()).not.toContain('Browser gateway tool schemas deferred');
    // The returned options still request deferral: the final seam reconciles
    // it with the real model and account home, so telemetry must not change it.
    expect(browser).toHaveProperty('toolDeferral', true);
  });

  it('keeps the deferred report when Claude tool search is off or unknown', () => {
    writeClaudeSettingsEnv({ ENABLE_TOOL_SEARCH: 'false' });
    const builder = makeBuilder();
    builder.getBrowserGatewayMcpOptions({ type: 'local' }, 'inst-2', 'claude');
    expect(loggedMessages()).toContain('Browser gateway tool schemas deferred');

    loggerMocks.info.mockClear();
    writeClaudeSettingsEnv({});
    builder.getBrowserGatewayMcpOptions({ type: 'local' }, 'inst-2', 'claude');
    expect(loggedMessages()).toContain('Browser gateway tool schemas deferred');
  });

  it('uses the final seam precedence: the settings file env beats the inherited process env', () => {
    writeClaudeSettingsEnv({ ENABLE_TOOL_SEARCH: 'false' });
    vi.stubEnv('ENABLE_TOOL_SEARCH', 'auto:0');
    makeBuilder().getBrowserGatewayMcpOptions({ type: 'local' }, 'inst-3', 'claude');
    expect(loggedMessages()).toContain('Browser gateway tool schemas deferred');

    loggerMocks.info.mockClear();
    writeClaudeSettingsEnv({});
    makeBuilder().getBrowserGatewayMcpOptions({ type: 'local' }, 'inst-3', 'claude');
    expect(loggedMessages()).toContain('Browser gateway tool schemas injected eagerly');
  });

  it('never applies the Claude override to other providers', () => {
    writeClaudeSettingsEnv({ ENABLE_TOOL_SEARCH: 'auto:0' });
    const builder = makeBuilder();
    builder.getBrowserGatewayMcpOptions({ type: 'local' }, 'inst-4', 'codex');
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'Browser gateway tool schemas deferred',
      expect.objectContaining({ instanceId: 'inst-4', toolMode: 'stable' }),
    );
  });
});
