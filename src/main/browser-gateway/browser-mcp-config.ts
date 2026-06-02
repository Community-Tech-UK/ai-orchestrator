import { existsSync } from 'node:fs';
import type { AcpMcpServerConfig } from '../../shared/types/cli.types';

/**
 * MCP config writer for the browser-gateway stdio forwarder.
 *
 * The forwarder is dispatched via the shared `aio-mcp` Node SEA binary:
 *
 *   command: <resources>/aio-mcp-cli/aio-mcp
 *   args:    ['browser-gateway']
 *   env:     {
 *     AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: <parent RPC socket path>,
 *     AI_ORCHESTRATOR_BROWSER_INSTANCE_ID:    <auth handle for the parent>,
 *     AI_ORCHESTRATOR_BROWSER_PROVIDER:       <optional provider override>,
 *   }
 *
 * The forwarder talks to `BrowserGatewayRpcServer` running in the parent
 * over the Unix socket — no `better-sqlite3` dependency in the spawned
 * binary, compatible with the `RunAsNode=false` Electron hardening fuse.
 */
export interface BrowserGatewayMcpConfigOptions {
  aioMcpCliPath: string;
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
  if (!exists(options.aioMcpCliPath)) {
    return null;
  }

  const env = {
    AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: options.socketPath,
    AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: options.instanceId,
    ...(options.provider ? { AI_ORCHESTRATOR_BROWSER_PROVIDER: options.provider } : {}),
  };

  return {
    command: options.aioMcpCliPath,
    args: ['browser-gateway'],
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
    // Browser tools can intentionally wait (wait_for ≤120s, downloads ≤60s);
    // keep the host tool timeout above those budgets so slow-but-valid calls
    // are not cut off with a misleading failure.
    'tool_timeout_sec = 130',
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
        // Above wait_for (≤120s) / download (≤60s) budgets — see Codex config.
        timeout: 130_000,
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
