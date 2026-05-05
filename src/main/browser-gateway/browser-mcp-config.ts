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
  provider?: string;
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

  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: options.socketPath,
    AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: options.instanceId,
    ...(options.provider ? { AI_ORCHESTRATOR_BROWSER_PROVIDER: options.provider } : {}),
  };

  return {
    command: options.execPath,
    args: [scriptPath],
    env,
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

export function buildBrowserGatewayCodexConfigToml(
  options: BrowserGatewayMcpConfigOptions,
): string | null {
  const bridge = resolveBrowserGatewayBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return [
    '[mcp_servers."browser-gateway"]',
    `command = ${tomlString(bridge.command)}`,
    `args = ${tomlArray(bridge.args)}`,
    'enabled = true',
    'required = false',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    '',
    '[mcp_servers."browser-gateway".env]',
    ...Object.entries(bridge.env).map(([name, value]) =>
      `${tomlBareKey(name)} = ${tomlString(value)}`,
    ),
  ].join('\n');
}

export function buildBrowserGatewayGeminiSettingsJson(
  options: BrowserGatewayMcpConfigOptions,
): string | null {
  const bridge = resolveBrowserGatewayBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return JSON.stringify({
    mcpServers: {
      'browser-gateway': {
        command: bridge.command,
        args: bridge.args,
        env: bridge.env,
        timeout: 30_000,
        trust: false,
      },
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function tomlBareKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : tomlString(value);
}
