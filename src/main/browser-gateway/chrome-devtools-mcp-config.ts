import type { AcpMcpServerConfig } from '../../shared/types/cli.types';
import {
  tomlArray,
  tomlString,
  tomlTableKey,
  toWindowsSafeBridge,
} from './mcp-config-toml-helpers';

/**
 * MCP config writer for the `chrome-devtools` server when it is **attached** to
 * an Harness-managed Chrome profile.
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
// Pinned (not `@latest`) for deterministic behavior and a stable npx cache: the
// first spawn fetches this exact version once and reuses it — no per-launch
// re-resolution, no surprise upgrades mid-automation. Bump this deliberately
// when adopting a newer chrome-devtools-mcp release (verify against the running
// Chrome major). See docs/remote-browser-automation-runbook.md.
export const CHROME_DEVTOOLS_MCP_VERSION = '1.2.0';
const DEFAULT_BASE_ARGS = ['-y', `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`];
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
  const command = options.command ?? DEFAULT_COMMAND;
  const args = [...baseArgs, '--browserUrl', options.browserUrl];
  return toWindowsSafeBridge(command, args);
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
    `[mcp_servers.${tomlTableKey(name)}]`,
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
