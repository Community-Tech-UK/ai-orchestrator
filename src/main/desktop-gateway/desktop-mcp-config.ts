import { existsSync } from 'node:fs';
import type { AcpMcpServerConfig } from '../../shared/types/cli.types';
import { tomlArray, tomlBareKey, tomlString } from '../browser-gateway/mcp-config-toml-helpers';

/**
 * MCP server *registration name* injected for every provider (the key under
 * `mcpServers` / the `[mcp_servers."..."]` TOML table / the ACP `name` field).
 *
 * MUST NOT be the literal string `computer-use` (LT-040). The real Claude CLI
 * treats that exact name as reserved for its own built-in desktop-automation
 * MCP server: `My()`/`XNs()` in the CLI bundle gate connection per-project via
 * an opt-in `enabledMcpServers` allowlist that defaults to *disabled* only for
 * that one literal name (every other server name defaults to *enabled*
 * unless explicitly disabled). A user-supplied `--mcp-config` server named
 * `computer-use` is silently classified `type: "disabled"` before the CLI
 * ever attempts to spawn it — no error, no child process, no log line on our
 * side — which is why Claude-provider instances could never reach any
 * `computer.*` tool even though the injected config, the socket, and the
 * `aio-mcp computer-use` binary were all independently verified healthy.
 * The `aio-mcp` CLI *subcommand* (`args: ['computer-use']` below) is
 * unrelated and unaffected — only the server's registered name collided.
 */
export const COMPUTER_USE_MCP_SERVER_NAME = 'harness-computer-use';

export interface ComputerUseMcpConfigOptions {
  aioMcpCliPath: string;
  socketPath: string;
  instanceId: string;
  provider?: string;
  /**
   * Health-gated allowlist of `computer.*` tool names. When present, the
   * spawned forwarder only exposes these tools. Omitted means all tools.
   */
  toolNames?: string[];
  exists?: (candidatePath: string) => boolean;
}

interface ComputerUseBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function resolveComputerUseBridgeSpec(
  options: ComputerUseMcpConfigOptions,
): ComputerUseBridgeSpec | null {
  const exists = options.exists ?? existsSync;
  if (!exists(options.aioMcpCliPath)) {
    return null;
  }
  return {
    command: options.aioMcpCliPath,
    args: ['computer-use'],
    env: {
      AI_ORCHESTRATOR_DESKTOP_GATEWAY_SOCKET: options.socketPath,
      AI_ORCHESTRATOR_DESKTOP_INSTANCE_ID: options.instanceId,
      ...(options.provider ? { AI_ORCHESTRATOR_DESKTOP_PROVIDER: options.provider } : {}),
      ...(options.toolNames && options.toolNames.length > 0
        ? { AI_ORCHESTRATOR_DESKTOP_TOOLS: options.toolNames.join(',') }
        : {}),
    },
  };
}

export function buildComputerUseMcpConfigJson(
  options: ComputerUseMcpConfigOptions,
): string | null {
  const bridge = resolveComputerUseBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return JSON.stringify({
    mcpServers: {
      [COMPUTER_USE_MCP_SERVER_NAME]: bridge,
    },
  });
}

export function buildComputerUseCodexConfigToml(
  options: ComputerUseMcpConfigOptions,
): string | null {
  const bridge = resolveComputerUseBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return [
    `[mcp_servers."${COMPUTER_USE_MCP_SERVER_NAME}"]`,
    `command = ${tomlString(bridge.command)}`,
    `args = ${tomlArray(bridge.args)}`,
    'enabled = true',
    'required = false',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    '',
    `[mcp_servers."${COMPUTER_USE_MCP_SERVER_NAME}".env]`,
    ...Object.entries(bridge.env).map(([name, value]) =>
      `${tomlBareKey(name)} = ${tomlString(value)}`,
    ),
  ].join('\n');
}

export function buildComputerUseGeminiSettingsJson(
  options: ComputerUseMcpConfigOptions,
): string | null {
  const bridge = resolveComputerUseBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return JSON.stringify({
    mcpServers: {
      [COMPUTER_USE_MCP_SERVER_NAME]: {
        command: bridge.command,
        args: bridge.args,
        env: bridge.env,
        timeout: 60_000,
        trust: false,
      },
    },
  });
}

export function buildComputerUseAcpMcpServers(
  options: ComputerUseMcpConfigOptions,
): AcpMcpServerConfig[] {
  const bridge = resolveComputerUseBridgeSpec(options);
  if (!bridge) {
    return [];
  }
  return [
    {
      name: COMPUTER_USE_MCP_SERVER_NAME,
      command: bridge.command,
      args: bridge.args,
      env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })),
    },
  ];
}
