import type { AcpMcpServerConfig } from '../../shared/types/cli.types';
import {
  tomlArray,
  tomlBareKey,
  tomlString,
  tomlTableKey,
  toWindowsSafeBridge,
} from './mcp-config-toml-helpers';

export interface MobileMcpConfigOptions {
  serial: string;
  sdkPath: string;
  kind?: 'emulator' | 'usb' | 'wifi';
  command?: string;
  baseArgs?: string[];
  serverName?: string;
  version?: string;
  maestro?: boolean;
}

interface MobileMcpBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const DEFAULT_COMMAND = 'npx';
export const MOBILE_MCP_VERSION = '0.0.59';
const DEFAULT_SERVER_NAME = 'mobile-mcp';
const MAESTRO_SERVER_NAME = 'maestro';
const TOOL_TIMEOUT_SEC = 130;

export function resolveMobileMcpBridgeSpec(
  options: MobileMcpConfigOptions,
): MobileMcpBridgeSpec | null {
  if (!options.serial) {
    return null;
  }
  const version = options.version ?? MOBILE_MCP_VERSION;
  const baseArgs = options.baseArgs ?? ['-y', `@mobilenext/mobile-mcp@${version}`];
  const bridge = toWindowsSafeBridge(options.command ?? DEFAULT_COMMAND, baseArgs);
  return {
    ...bridge,
    env: {
      MOBILEMCP_DISABLE_TELEMETRY: '1',
      ...(options.sdkPath ? {
        ANDROID_HOME: options.sdkPath,
        ANDROID_SDK_ROOT: options.sdkPath,
      } : {}),
      ANDROID_SERIAL: options.serial,
    },
  };
}

export function buildMobileMcpConfigJson(options: MobileMcpConfigOptions): string | null {
  const bridge = resolveMobileMcpBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  const servers: Record<string, MobileMcpBridgeSpec> = {
    [serverNameOf(options)]: bridge,
  };
  const maestro = resolveMaestroMcpBridgeSpec(options);
  if (maestro) {
    servers[MAESTRO_SERVER_NAME] = maestro;
  }
  return JSON.stringify({
    mcpServers: servers,
  });
}

export function buildMobileMcpCodexConfigToml(options: MobileMcpConfigOptions): string | null {
  const bridge = resolveMobileMcpBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  const name = serverNameOf(options);
  const blocks = [
    `[mcp_servers.${tomlTableKey(name)}]`,
    `command = ${tomlString(bridge.command)}`,
    `args = ${tomlArray(bridge.args)}`,
    'enabled = true',
    'required = false',
    'startup_timeout_sec = 20',
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
    '',
    `[mcp_servers.${tomlTableKey(name)}.env]`,
    ...Object.entries(bridge.env).map(([key, value]) =>
      `${tomlBareKey(key)} = ${tomlString(value)}`
    ),
  ];
  const maestro = resolveMaestroMcpBridgeSpec(options);
  if (maestro) {
    blocks.push(
      '',
      `[mcp_servers.${MAESTRO_SERVER_NAME}]`,
      `command = ${tomlString(maestro.command)}`,
      `args = ${tomlArray(maestro.args)}`,
      'enabled = true',
      'required = false',
      'startup_timeout_sec = 20',
      `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
      '',
      `[mcp_servers.${MAESTRO_SERVER_NAME}.env]`,
      ...Object.entries(maestro.env).map(([key, value]) =>
        `${tomlBareKey(key)} = ${tomlString(value)}`
      ),
    );
  }
  return blocks.join('\n');
}

export function buildMobileMcpGeminiSettingsJson(options: MobileMcpConfigOptions): string | null {
  const bridge = resolveMobileMcpBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  const mcpServers: Record<string, unknown> = {
    [serverNameOf(options)]: {
      command: bridge.command,
      args: bridge.args,
      env: bridge.env,
      timeout: TOOL_TIMEOUT_SEC * 1_000,
      trust: false,
    },
  };
  const maestro = resolveMaestroMcpBridgeSpec(options);
  if (maestro) {
    mcpServers[MAESTRO_SERVER_NAME] = {
      command: maestro.command,
      args: maestro.args,
      env: maestro.env,
      timeout: TOOL_TIMEOUT_SEC * 1_000,
      trust: false,
    };
  }
  return JSON.stringify({
    mcpServers,
  });
}

export function buildMobileMcpAcpMcpServers(options: MobileMcpConfigOptions): AcpMcpServerConfig[] {
  const bridge = resolveMobileMcpBridgeSpec(options);
  if (!bridge) {
    return [];
  }
  const servers: AcpMcpServerConfig[] = [{
    name: serverNameOf(options),
    command: bridge.command,
    args: bridge.args,
    env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })),
  }];
  const maestro = resolveMaestroMcpBridgeSpec(options);
  if (maestro) {
    servers.push({
      name: MAESTRO_SERVER_NAME,
      command: maestro.command,
      args: maestro.args,
      env: Object.entries(maestro.env).map(([name, value]) => ({ name, value })),
    });
  }
  return servers;
}

function serverNameOf(options: MobileMcpConfigOptions): string {
  const requested = options.serverName ?? DEFAULT_SERVER_NAME;
  return options.maestro === true && requested.toLowerCase() === MAESTRO_SERVER_NAME
    ? DEFAULT_SERVER_NAME
    : requested;
}

function resolveMaestroMcpBridgeSpec(options: MobileMcpConfigOptions): MobileMcpBridgeSpec | null {
  if (options.maestro !== true || !options.serial) {
    return null;
  }
  const bridge = toWindowsSafeBridge('maestro', ['mcp']);
  return {
    ...bridge,
    env: {
      ...(options.sdkPath ? {
        ANDROID_HOME: options.sdkPath,
        ANDROID_SDK_ROOT: options.sdkPath,
      } : {}),
      ANDROID_SERIAL: options.serial,
    },
  };
}
