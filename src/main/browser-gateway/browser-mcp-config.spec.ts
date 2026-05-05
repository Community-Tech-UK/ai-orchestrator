import { describe, expect, it } from 'vitest';
import {
  buildBrowserGatewayAcpMcpServers,
  buildBrowserGatewayCodexConfigToml,
  buildBrowserGatewayGeminiSettingsJson,
  buildBrowserGatewayMcpConfigJson,
  resolveBrowserGatewayBridgeSpec,
} from './browser-mcp-config';

const options = {
  currentDir: '/app/dist/main/instance',
  execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
  isPackaged: false,
  resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
  socketPath: '/tmp/browser-gateway.sock',
  instanceId: 'instance-1',
  exists: () => true,
};

describe('browser-mcp-config', () => {
  it('resolves non-packaged and packaged bridge paths', () => {
    expect(resolveBrowserGatewayBridgeSpec(options)?.args[0]).toBe(
      '/app/dist/main/browser-gateway/browser-mcp-stdio-server.js',
    );
    expect(
      resolveBrowserGatewayBridgeSpec({
        ...options,
        isPackaged: true,
      })?.args[0],
    ).toBe(
      '/Applications/AI Orchestrator.app/Contents/Resources/app.asar/dist/main/browser-gateway/browser-mcp-stdio-server.js',
    );
  });

  it('builds Claude inline JSON config with record env', () => {
    const config = JSON.parse(buildBrowserGatewayMcpConfigJson(options)!);
    const server = config.mcpServers['browser-gateway'];

    expect(server.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: '/tmp/browser-gateway.sock',
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
    });
  });

  it('builds ACP config with env array entries', () => {
    const [server] = buildBrowserGatewayAcpMcpServers(options);

    expect(server.name).toBe('browser-gateway');
    expect(server.env).toEqual([
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      {
        name: 'AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET',
        value: '/tmp/browser-gateway.sock',
      },
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

  it('builds Codex TOML config for the Browser Gateway MCP server', () => {
    const config = buildBrowserGatewayCodexConfigToml({
      ...options,
      provider: 'codex',
    });

    expect(config).toContain('[mcp_servers."browser-gateway"]');
    expect(config).toContain('command = "/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator"');
    expect(config).toContain('args = ["/app/dist/main/browser-gateway/browser-mcp-stdio-server.js"]');
    expect(config).toContain('AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET = "/tmp/browser-gateway.sock"');
    expect(config).toContain('AI_ORCHESTRATOR_BROWSER_PROVIDER = "codex"');
  });

  it('builds Gemini settings JSON for the Browser Gateway MCP server', () => {
    const config = JSON.parse(buildBrowserGatewayGeminiSettingsJson({
      ...options,
      provider: 'gemini',
    })!);

    expect(config.mcpServers['browser-gateway']).toMatchObject({
      command: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      args: ['/app/dist/main/browser-gateway/browser-mcp-stdio-server.js'],
      env: expect.objectContaining({
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: '/tmp/browser-gateway.sock',
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
        AI_ORCHESTRATOR_BROWSER_PROVIDER: 'gemini',
      }),
    });
  });
});
