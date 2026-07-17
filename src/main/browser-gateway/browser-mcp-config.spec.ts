import { describe, expect, it } from 'vitest';
import {
  buildBrowserGatewayAcpMcpServers,
  buildBrowserGatewayCodexConfigToml,
  buildBrowserGatewayGeminiSettingsJson,
  buildBrowserGatewayMcpConfigJson,
  resolveBrowserGatewayBridgeSpec,
} from './browser-mcp-config';

const AIO_MCP = '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const SOCKET = '/tmp/browser-gateway.sock';
const options = {
  aioMcpCliPath: AIO_MCP,
  socketPath: SOCKET,
  instanceId: 'instance-1',
  exists: () => true,
};

describe('browser-mcp-config', () => {
  it('builds a bridge pointing at the aio-mcp SEA browser-gateway subcommand', () => {
    const bridge = resolveBrowserGatewayBridgeSpec(options);

    expect(bridge).toEqual({
      command: AIO_MCP,
      args: ['browser-gateway'],
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: SOCKET,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
      },
    });
  });

  it('returns null when the aio-mcp SEA is missing', () => {
    expect(
      resolveBrowserGatewayBridgeSpec({ ...options, exists: () => false }),
    ).toBeNull();
  });

  it('builds Claude inline JSON config with record env — no ELECTRON_RUN_AS_NODE', () => {
    const config = JSON.parse(buildBrowserGatewayMcpConfigJson(options)!);
    const server = config.mcpServers['browser-gateway'];

    expect(server.env).toEqual({
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: SOCKET,
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
    });
    expect(server.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('builds ACP config with env array entries — no ELECTRON_RUN_AS_NODE', () => {
    const [server] = buildBrowserGatewayAcpMcpServers(options);

    expect(server.name).toBe('browser-gateway');
    expect(server.env).toEqual([
      { name: 'AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET', value: SOCKET },
      { name: 'AI_ORCHESTRATOR_BROWSER_INSTANCE_ID', value: 'instance-1' },
    ]);
  });

  it('passes provider identity through the bridge environment when supplied', () => {
    const bridge = resolveBrowserGatewayBridgeSpec({
      ...options,
      provider: 'copilot',
    });

    expect(bridge?.env).toMatchObject({
      AI_ORCHESTRATOR_BROWSER_PROVIDER: 'copilot',
    });
  });

  it('sets the tool-deferral env flag only when requested (WS9)', () => {
    const withDeferral = resolveBrowserGatewayBridgeSpec({
      ...options,
      toolDeferral: true,
    });
    expect(withDeferral?.env).toMatchObject({
      AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL: '1',
    });

    const withoutDeferral = resolveBrowserGatewayBridgeSpec(options);
    expect(withoutDeferral?.env).not.toHaveProperty('AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL');
  });

  it('builds Codex TOML config pointing at the aio-mcp SEA', () => {
    const config = buildBrowserGatewayCodexConfigToml({
      ...options,
      provider: 'codex',
    });

    expect(config).toContain('[mcp_servers."browser-gateway"]');
    expect(config).toContain(`command = "${AIO_MCP}"`);
    expect(config).toContain('args = ["browser-gateway"]');
    expect(config).toContain(`AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET = "${SOCKET}"`);
    expect(config).toContain('AI_ORCHESTRATOR_BROWSER_PROVIDER = "codex"');
  });

  it('builds Gemini settings JSON pointing at the aio-mcp SEA', () => {
    const config = JSON.parse(buildBrowserGatewayGeminiSettingsJson({
      ...options,
      provider: 'gemini',
    })!);

    expect(config.mcpServers['browser-gateway']).toMatchObject({
      command: AIO_MCP,
      args: ['browser-gateway'],
      env: expect.objectContaining({
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: SOCKET,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
        AI_ORCHESTRATOR_BROWSER_PROVIDER: 'gemini',
      }),
    });
  });
});
