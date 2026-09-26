/**
 * Converts the static, user-managed `config/mcp-servers.json` into ACP
 * `McpServer` entries so ACP-spawned workers (Grok, OpenCode, …) expose the
 * same custom MCP servers (lsp, imap, …) that Claude gets via `--mcp-config`
 * and Codex via `buildStaticMcpServersCodexConfigToml`.
 *
 * `UnifiedSpawnOptions.mcpConfig` is a mix of file paths and inline JSON.
 * `buildInlineMcpServersAcpMcpServers` only consumes the inline entries, so
 * without this the static file's servers are silently dropped for every ACP
 * provider. stdio and remote (HTTP/SSE) servers both convert; the latter only
 * reach agents advertising `mcpCapabilities.http`/`.sse` (filtered in
 * acp-cli-adapter at session/new).
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { AcpMcpServerConfig } from '../../../shared/types/cli.types';
import {
  DEDICATED_ACP_BRIDGE_SERVERS,
  toAcpMcpServer,
  type InlineJsonMcpServer,
} from './adapter-spawn-helpers';

/**
 * Basename of the static MCP config file (`config/mcp-servers.json`). Matching
 * on basename picks it out of the spawn's mcpConfig list without importing
 * spawn-config-builder (which pulls in electron `app`).
 */
const STATIC_MCP_CONFIG_BASENAME = 'mcp-servers.json';

/**
 * Builds the ACP MCP server list for every static `mcp-servers.json` file found
 * in `mcpConfigEntries`. Returns an empty list when there is nothing to inject.
 */
export function buildStaticMcpServersAcpMcpServers(
  mcpConfigEntries: string[] | undefined,
): AcpMcpServerConfig[] {
  if (!mcpConfigEntries?.length) {
    return [];
  }

  const servers = new Map<string, AcpMcpServerConfig>();
  for (const entry of mcpConfigEntries) {
    const trimmed = entry.trim();
    // Skip inline JSON bridges — those arrive through
    // buildInlineMcpServersAcpMcpServers or a dedicated channel.
    if (trimmed.startsWith('{')) {
      continue;
    }
    if (basename(trimmed) !== STATIC_MCP_CONFIG_BASENAME || !existsSync(trimmed)) {
      continue;
    }

    let parsed: { mcpServers?: Record<string, InlineJsonMcpServer> };
    try {
      parsed = JSON.parse(readFileSync(trimmed, 'utf8')) as {
        mcpServers?: Record<string, InlineJsonMcpServer>;
      };
    } catch {
      continue; // a malformed static config shouldn't break the spawn
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
