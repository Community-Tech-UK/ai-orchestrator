/**
 * ACP `session/new` / `session/load` MCP-server conversion.
 *
 * Spawn MCP config arrives as `UnifiedSpawnOptions.mcpConfig` (a mix of file
 * paths and inline `{mcpServers: …}` JSON) plus dedicated bridge channels. This
 * module converts the generic entries into `AcpMcpServerConfig` wire entries
 * (agent-client-protocol, "MCP Servers"): stdio as name/command/args/env, and
 * remote HTTP/SSE as type/url/headers. Extracted from adapter-spawn-helpers.ts
 * (which re-exports these) to keep that file under its size cap.
 */

import type { AcpMcpServerConfig } from '../../../shared/types/cli.types';

export interface InlineJsonMcpServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  /** Generic `mcpServers` entries carry `transport`; Claude-style ones `type`. */
  transport?: unknown;
  type?: unknown;
}

export const DEDICATED_ACP_BRIDGE_SERVERS = new Set([
  'browser-gateway',
  'chrome-devtools',
  'mobile-mcp',
  'maestro',
]);

function toAcpHeaders(value: unknown): Array<{ name: string; value: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, headerValue]) => ({ name, value: headerValue }));
}

export function toAcpMcpServer(name: string, server: InlineJsonMcpServer): AcpMcpServerConfig | null {
  if (typeof server.command === 'string' && server.command.trim()) {
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined;
    const env = server.env &&
      typeof server.env === 'object' &&
      !Array.isArray(server.env)
      ? Object.entries(server.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([envName, value]) => ({ name: envName, value }))
      : undefined;
    return {
      name,
      command: server.command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && env.length > 0 ? { env } : {}),
    };
  }
  if (typeof server.url === 'string' && server.url.trim()) {
    // HTTP/SSE form (agent-client-protocol "MCP Servers"). The `headers` array
    // is required by the protocol even when empty. An explicit `transport`/
    // `type` of "http" selects HTTP; anything else with a URL is SSE, matching
    // the internal normalized model (url + no transport → 'sse').
    const explicit = typeof server.transport === 'string'
      ? server.transport
      : typeof server.type === 'string' ? server.type : undefined;
    return {
      name,
      type: explicit === 'http' ? 'http' : 'sse',
      url: server.url,
      headers: toAcpHeaders(server.headers),
    };
  }
  return null;
}

export function buildInlineMcpServersAcpMcpServers(
  mcpConfigEntries: string[] | undefined,
): AcpMcpServerConfig[] {
  if (!mcpConfigEntries?.length) {
    return [];
  }

  const servers = new Map<string, AcpMcpServerConfig>();
  for (const entry of mcpConfigEntries) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    let parsed: { mcpServers?: Record<string, InlineJsonMcpServer> };
    try {
      parsed = JSON.parse(trimmed) as { mcpServers?: Record<string, InlineJsonMcpServer> };
    } catch {
      continue;
    }

    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
      if (DEDICATED_ACP_BRIDGE_SERVERS.has(name)) {
        continue;
      }
      const acpServer = toAcpMcpServer(name, server);
      if (acpServer) {
        servers.set(name, acpServer);
      }
    }
  }

  return [...servers.values()];
}

/**
 * Concatenate ACP MCP server lists with first-wins name dedupe. The spawn
 * config can describe the same server through several channels (static
 * `mcp-servers.json`, inline workspace/orchestrator entries, caller-supplied);
 * the agent must see exactly one entry per name.
 */
export function mergeAcpMcpServers(
  ...lists: Array<AcpMcpServerConfig[] | undefined>
): AcpMcpServerConfig[] {
  const merged = new Map<string, AcpMcpServerConfig>();
  for (const list of lists) {
    for (const server of list ?? []) {
      if (!merged.has(server.name)) {
        merged.set(server.name, server);
      }
    }
  }
  return [...merged.values()];
}
