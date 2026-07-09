import { existsSync } from 'node:fs';
import type { AcpMcpServerConfig } from '../../shared/types/cli.types';
import { tomlArray, tomlBareKey, tomlString } from '../browser-gateway/mcp-config-toml-helpers';

export interface ComputerUseMcpConfigOptions {
  aioMcpCliPath: string;
  socketPath: string;
  instanceId: string;
  provider?: string;
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
      'computer-use': bridge,
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
    '[mcp_servers."computer-use"]',
    `command = ${tomlString(bridge.command)}`,
    `args = ${tomlArray(bridge.args)}`,
    'enabled = true',
    'required = false',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    '',
    '[mcp_servers."computer-use".env]',
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
      'computer-use': {
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
      name: 'computer-use',
      command: bridge.command,
      args: bridge.args,
      env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })),
    },
  ];
}
