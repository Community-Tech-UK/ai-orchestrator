/**
 * Converts the static, user-managed `config/mcp-servers.json` into Codex
 * `[mcp_servers.<name>]` TOML blocks so that Codex workers expose the same
 * custom MCP servers (lsp, imap, …) that Claude/Copilot workers already get via
 * `--mcp-config`.
 *
 * Codex does not accept `--mcp-config`; its MCP servers are injected through a
 * synthetic CODEX_HOME built from `mcpServersConfigToml` (see
 * codex-cli-adapter). The dynamically-injected bridges (browser-gateway,
 * chrome-devtools, codemem, orchestrator-tools) are handled through their own
 * channels, so this helper deliberately ignores them and converts only the
 * static config file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CodexTomlEditor, type CodexTomlServer } from '../../mcp/adapters/codex-toml-editor';

/**
 * Basename of the static MCP config file (`config/mcp-servers.json`). The same
 * file is passed to Claude/Copilot via `--mcp-config`; matching on basename
 * lets us pick it out of the spawn's mcpConfig list without importing
 * spawn-config-builder (which pulls in electron `app`).
 */
const STATIC_MCP_CONFIG_BASENAME = 'mcp-servers.json';

interface JsonMcpServer {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Some configs use `type`, others `transport`; both are accepted. */
  type?: string;
  transport?: string;
}

function toCodexServer(server: JsonMcpServer): CodexTomlServer {
  const transport = server.transport ?? server.type;
  return {
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    env: server.env,
    // stdio is Codex's default and is omitted; only sse/http are written out.
    transport:
      transport === 'sse' || transport === 'http' ? transport : undefined,
  };
}

/**
 * Builds the combined Codex TOML for every server in the static config file(s)
 * found in `mcpConfigEntries`. Returns null when there is nothing to inject.
 *
 * @param mcpConfigEntries The spawn's `mcpConfig` list — a mix of file paths
 *   (static config + bridge temp files) and inline JSON strings. Only the
 *   static `mcp-servers.json` file is converted.
 */
export function buildStaticMcpServersCodexConfigToml(
  mcpConfigEntries: string[] | undefined,
): string | null {
  if (!mcpConfigEntries?.length) {
    return null;
  }

  const editor = new CodexTomlEditor();
  let toml = '';

  for (const entry of mcpConfigEntries) {
    const trimmed = entry.trim();
    // Skip inline JSON bridges (browser-gateway, chrome-devtools, codemem,
    // orchestrator-tools) — Codex receives those through dedicated channels.
    if (trimmed.startsWith('{')) {
      continue;
    }
    if (basename(trimmed) !== STATIC_MCP_CONFIG_BASENAME || !existsSync(trimmed)) {
      continue;
    }

    let parsed: { mcpServers?: Record<string, JsonMcpServer> };
    try {
      parsed = JSON.parse(readFileSync(trimmed, 'utf8')) as {
        mcpServers?: Record<string, JsonMcpServer>;
      };
    } catch {
      continue; // a malformed static config shouldn't break the spawn
    }

    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
      toml = editor.upsertMcpServer(toml, name, toCodexServer(server));
    }
  }

  const result = toml.trim();
  return result.length > 0 ? result : null;
}
