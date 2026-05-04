import { describe, expect, it } from 'vitest';
import {
  buildBrowserGatewayAcpMcpServers,
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
});
