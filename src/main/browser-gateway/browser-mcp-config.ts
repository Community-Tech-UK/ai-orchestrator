import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { AcpMcpServerConfig } from '../../shared/types/cli.types';

export interface BrowserGatewayMcpConfigOptions {
  currentDir: string;
  execPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  socketPath: string;
  instanceId: string;
  exists?: (candidatePath: string) => boolean;
}

interface BrowserGatewayBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function resolveBrowserGatewayBridgeSpec(
  options: BrowserGatewayMcpConfigOptions,
): BrowserGatewayBridgeSpec | null {
  const exists = options.exists ?? existsSync;
  const scriptPath = options.isPackaged
    ? path.join(
        options.resourcesPath,
        'app.asar',
        'dist',
        'main',
        'browser-gateway',
        'browser-mcp-stdio-server.js',
      )
    : path.resolve(options.currentDir, '../browser-gateway/browser-mcp-stdio-server.js');

  if (!exists(scriptPath)) {
    return null;
  }

  return {
    command: options.execPath,
    args: [scriptPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: options.socketPath,
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: options.instanceId,
    },
  };
}

export function buildBrowserGatewayMcpConfigJson(
  options: BrowserGatewayMcpConfigOptions,
): string | null {
  const bridge = resolveBrowserGatewayBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return JSON.stringify({
    mcpServers: {
      'browser-gateway': bridge,
    },
  });
}

export function buildBrowserGatewayAcpMcpServers(
  options: BrowserGatewayMcpConfigOptions,
): AcpMcpServerConfig[] {
  const bridge = resolveBrowserGatewayBridgeSpec(options);
  if (!bridge) {
    return [];
  }
  return [
    {
      name: 'browser-gateway',
      command: bridge.command,
      args: bridge.args,
      env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })),
    },
  ];
}
