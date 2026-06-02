import type { AcpMcpServerConfig } from '../../shared/types/cli.types';

/**
 * MCP config writer for the `chrome-devtools` server when it is **attached** to
 * an AIO-managed Chrome profile.
 *
 * Unlike the static user-scoped chrome-devtools server (which launches its own
 * Chrome), the attached config injects `--browserUrl http://127.0.0.1:<port>` so
 * chrome-devtools-mcp connects to the managed profile's CDP endpoint. The server
 * connects lazily on first tool use, so this config is safe to bake into the
 * agent's spawn even though the managed Chrome is not yet running — the agent
 * opens/logs-into the profile via `browser.*` first.
 *
 * Mirrors the per-provider shape of `browser-mcp-config.ts`.
 */
export interface ChromeDevtoolsMcpConfigOptions {
  /** CDP endpoint to attach to, e.g. `http://127.0.0.1:31234`. Required. */
  browserUrl: string;
  /** Launch command. Defaults to `npx`. */
  command?: string;
  /** Args before the injected `--browserUrl`. Defaults to the npx package spec. */
  baseArgs?: string[];
  /** MCP server name (config key). Defaults to `chrome-devtools`. */
  serverName?: string;
}

interface ChromeDevtoolsBridgeSpec {
  command: string;
  args: string[];
}

const DEFAULT_COMMAND = 'npx';
const DEFAULT_BASE_ARGS = ['-y', 'chrome-devtools-mcp@latest'];
const DEFAULT_SERVER_NAME = 'chrome-devtools';
// chrome-devtools tools (performance traces, navigations) can legitimately run
// for a while; keep the host tool timeout generous so slow-but-valid calls are
// not cut off.
const TOOL_TIMEOUT_SEC = 130;

export function resolveChromeDevtoolsBridgeSpec(
  options: ChromeDevtoolsMcpConfigOptions,
): ChromeDevtoolsBridgeSpec | null {
  if (!options.browserUrl) {
    return null;
  }
  const baseArgs = options.baseArgs ?? DEFAULT_BASE_ARGS;
  return {
    command: options.command ?? DEFAULT_COMMAND,
    args: [...baseArgs, '--browserUrl', options.browserUrl],
  };
}

function serverNameOf(options: ChromeDevtoolsMcpConfigOptions): string {
  return options.serverName ?? DEFAULT_SERVER_NAME;
}

export function buildChromeDevtoolsMcpConfigJson(
  options: ChromeDevtoolsMcpConfigOptions,
): string | null {
  const bridge = resolveChromeDevtoolsBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return JSON.stringify({
    mcpServers: {
      [serverNameOf(options)]: bridge,
    },
  });
}

export function buildChromeDevtoolsCodexConfigToml(
  options: ChromeDevtoolsMcpConfigOptions,
): string | null {
  const bridge = resolveChromeDevtoolsBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  const name = serverNameOf(options);
  return [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlString(bridge.command)}`,
    `args = ${tomlArray(bridge.args)}`,
    'enabled = true',
    'required = false',
    'startup_timeout_sec = 10',
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
  ].join('\n');
}

export function buildChromeDevtoolsGeminiSettingsJson(
  options: ChromeDevtoolsMcpConfigOptions,
): string | null {
  const bridge = resolveChromeDevtoolsBridgeSpec(options);
  if (!bridge) {
    return null;
  }
  return JSON.stringify({
    mcpServers: {
      [serverNameOf(options)]: {
        command: bridge.command,
        args: bridge.args,
        timeout: TOOL_TIMEOUT_SEC * 1_000,
        trust: false,
      },
    },
  });
}

export function buildChromeDevtoolsAcpMcpServers(
  options: ChromeDevtoolsMcpConfigOptions,
): AcpMcpServerConfig[] {
  const bridge = resolveChromeDevtoolsBridgeSpec(options);
  if (!bridge) {
    return [];
  }
  return [
    {
      name: serverNameOf(options),
      command: bridge.command,
      args: bridge.args,
      env: [],
    },
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

/** Bare key if it's a safe identifier, otherwise a quoted (dotted-safe) key. */
function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? `"${value}"` : tomlString(value);
}
