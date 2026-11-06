import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Plan Queue checkers (the schema's "verifier") and triage sessions skip the
// browser, desktop, imap and codemem servers; workers and ordinary sessions
// keep every server. The mocks below mirror instance-lifecycle-browser-mcp.spec.ts.
const BROWSER = '{"mcpServers":{"browser-gateway":{}}}';
const CHROME = '{"mcpServers":{"chrome-devtools":{}}}';
const COMPUTER = '{"mcpServers":{"computer-use":{}}}';
const CODEMEM = '{"mcpServers":{"codemem":{}}}';
const ORCHESTRATOR = '{"mcpServers":{"orchestrator":{}}}';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/harness', isPackaged: false } }));

const mocks = vi.hoisted(() => ({
  browserCapability: vi.fn<(instanceId: string) => string | null>(() => 'PLACEHOLDER_BROWSER_CAPABILITY'),
  buildBrowser: vi.fn(() => '{"mcpServers":{"browser-gateway":{}}}'),
  buildChrome: vi.fn(() => '{"mcpServers":{"chrome-devtools":{}}}'),
  buildComputer: vi.fn(() => '{"mcpServers":{"computer-use":{}}}'),
  buildCodemem: vi.fn(() => '{"mcpServers":{"codemem":{}}}'),
  warn: vi.fn(),
}));

vi.mock('../../browser-gateway', () => ({
  buildBrowserGatewayMcpConfigJson: mocks.buildBrowser,
  getBrowserGatewayRpcSocketPath: () => '/tmp/browser-gateway.sock',
  getBrowserGatewayRpcInstanceCapability: mocks.browserCapability,
  buildChromeDevtoolsMcpConfigJson: mocks.buildChrome,
  resolveChromeDevtoolsBrowserUrl: () => 'http://127.0.0.1:31234',
  createBrowserMcpTools: () => [{ name: 'browser.full', inputSchema: {} }],
  createDeferredBrowserMcpTools: () => [{ name: 'browser.visible', inputSchema: {}, hidden: false }],
  measureToolSchemaBytes: (tools: unknown[]) => tools.length * 100,
  resolveBrowserGatewayToolMode: (_provider?: string, deferred?: boolean) => (deferred ? 'deferred' : 'eager'),
}));
vi.mock('../../browser-gateway/browser-forwarder-log-retention', () => ({
  maybePruneBrowserForwarderLogs: () => ({ removed: 0 }),
}));
vi.mock('../../desktop-gateway', () => ({
  buildComputerUseMcpConfigJson: mocks.buildComputer,
  getDesktopGatewayRpcSocketPath: () => '/tmp/computer-use.sock',
  getDesktopGatewayInjectionState: () => ({ supported: true, enabled: true, actionToolsHealthy: true }),
}));
vi.mock('../../mcp/mcp-multi-provider-singletons', () => ({
  getOrchestratorInjectionReader: () => ({
    buildBundle: () => ({ configPaths: [], inlineConfigs: ['{"mcpServers":{"orchestrator-test":{}}}'] }),
  }),
}));
vi.mock('../../mcp/orchestrator-tools-mcp-config', () => ({
  buildOrchestratorToolsMcpConfig: () => '{"mcpServers":{"orchestrator":{}}}',
  resolveOrchestratorToolMode: () => 'eager',
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
  getOrchestratorToolsRpcInstanceCapability: () => 'cap-test-token',
}));
vi.mock('../../codemem/mcp-config', () => ({ buildCodememMcpConfig: mocks.buildCodemem }));
vi.mock('../../codemem/codemem-rpc-server', () => ({ getCodememRpcSocketPath: () => '/tmp/harness/cm-test.sock' }));
vi.mock('../../util/aio-mcp-cli-path', () => ({
  resolveAioMcpCliPath: () => '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp',
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: mocks.warn }),
}));

import type { SettingsManager } from '../../core/config/settings-manager';
import { MCP_CONFIG_PATH, SpawnConfigBuilder } from '../lifecycle/spawn-config-builder';

const LOCAL = { type: 'local' } as const;
const INSTANCES: Record<string, { metadata?: Record<string, unknown> }> = {
  'queue-verifier': { metadata: { planQueueRunId: 'run-1', planQueueRole: 'verifier' } },
  'queue-triage': { metadata: { planQueueRunId: 'run-1', planQueueRole: 'triage' } },
  'queue-worker': { metadata: { planQueueRunId: 'run-1', planQueueRole: 'worker' } },
  'ordinary-chat': { metadata: {} },
};

function makeBuilder(withInstances = true): SpawnConfigBuilder {
  const settings = {
    getAll: () => ({
      codememEnabled: true,
      computerUseEnabled: true,
      chromeDevtoolsAttachEnabled: true,
      chromeDevtoolsAttachProfileId: 'profile-attach',
      browserMcpToolDeferral: false,
      orchestratorMcpToolDeferral: false,
      interSessionMessaging: { enabled: false, allowCrossProject: false, maxHops: 1, rateLimitPerMinute: 5 },
    }),
    get: () => undefined,
  } as unknown as SettingsManager;
  return new SpawnConfigBuilder({ settings, ...(withInstances ? { getInstance: (id: string) => INSTANCES[id] } : {}) });
}

const staticServerNames = (): string[] => Object.keys(
  (JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers,
);
const inlineServerNames = (configs: string[]): string[] => configs
  .filter(entry => entry.startsWith('{'))
  .flatMap(entry => Object.keys((JSON.parse(entry) as { mcpServers: Record<string, unknown> }).mcpServers));

describe('SpawnConfigBuilder role-aware MCP servers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the shipped static config has an imap server for the exclusion to act on', () => {
    expect(staticServerNames()).toContain('imap');
  });

  it.each(['queue-verifier', 'queue-triage'])('%s: no browser, chrome-devtools, desktop or codemem server is configured', (id) => {
    const configs = makeBuilder().getMcpConfig(LOCAL, id, 'claude', '/work/repo');

    for (const config of [BROWSER, CHROME, COMPUTER, CODEMEM]) expect(configs).not.toContain(config);
    expect(mocks.buildBrowser).not.toHaveBeenCalled();
    expect(mocks.buildChrome).not.toHaveBeenCalled();
    expect(mocks.buildComputer).not.toHaveBeenCalled();
    expect(mocks.buildCodemem).not.toHaveBeenCalled();
    // A server that is skipped must not get a capability minted for it either.
    expect(mocks.browserCapability).not.toHaveBeenCalled();
    expect(configs).toContain(ORCHESTRATOR);
  });

  it.each(['queue-verifier', 'queue-triage'])('%s: keeps lsp but not imap from the static config, as an inline entry', (id) => {
    const configs = makeBuilder().getMcpConfig(LOCAL, id, 'claude', '/work/repo');

    expect(configs.map(entry => basename(entry))).not.toContain('mcp-servers.json');
    const names = inlineServerNames(configs);
    expect(names).not.toContain('imap');
    for (const kept of staticServerNames().filter(name => name !== 'imap')) expect(names).toContain(kept);
  });

  it.each(['queue-worker', 'ordinary-chat', 'unknown-instance'])('%s: keeps every server and the static config file', (id) => {
    const configs = makeBuilder().getMcpConfig(LOCAL, id, 'claude', '/work/repo');

    for (const config of [BROWSER, CHROME, COMPUTER, CODEMEM, ORCHESTRATOR]) expect(configs).toContain(config);
    expect(configs).toContain(MCP_CONFIG_PATH);
  });

  it('keeps every server when the builder was given no instance lookup', () => {
    const configs = makeBuilder(false).getMcpConfig(LOCAL, 'queue-verifier', 'claude', '/work/repo');

    for (const config of [BROWSER, CHROME, COMPUTER, CODEMEM]) expect(configs).toContain(config);
    expect(configs).toContain(MCP_CONFIG_PATH);
  });

  describe('direct provider options (used by Claude, Codex and ACP providers outside mcpConfig)', () => {
    it.each(['queue-verifier', 'queue-triage'])('%s gets no browser, chrome-devtools or computer-use options', (id) => {
      const builder = makeBuilder();

      expect(builder.getBrowserGatewayMcpOptions(LOCAL, id, 'codex')).toBeNull();
      expect(builder.getChromeDevtoolsMcpOptions(LOCAL, id)).toBeNull();
      expect(builder.getComputerUseMcpOptions(LOCAL, id, 'codex')).toBeNull();
      expect(mocks.browserCapability).not.toHaveBeenCalled();
    });

    it.each(['queue-worker', 'ordinary-chat'])('%s still gets all three', (id) => {
      const builder = makeBuilder();

      expect(builder.getBrowserGatewayMcpOptions(LOCAL, id, 'codex')).toMatchObject({ instanceId: id });
      expect(builder.getChromeDevtoolsMcpOptions(LOCAL, id)).toEqual({ browserUrl: 'http://127.0.0.1:31234' });
      expect(builder.getComputerUseMcpOptions(LOCAL, id, 'codex')).toMatchObject({ instanceId: id });
    });

    it('a chrome-devtools lookup without an instance id behaves as before', () => {
      expect(makeBuilder().getChromeDevtoolsMcpOptions(LOCAL, undefined)).toEqual({ browserUrl: 'http://127.0.0.1:31234' });
    });
  });
});
