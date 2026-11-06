/**
 * Role-aware MCP server selection for Plan Queue sessions.
 *
 * A queue checker (the schema's `verifier` role) or triage session reads files,
 * runs the documented checks and reports. It never drives a browser, the
 * desktop, the shared mailbox or the code-memory index, yet each of those
 * servers adds its tool list to every request the session makes. They are left
 * out for those two roles. Workers and every non-queue session are unchanged.
 *
 * Pure policy: `SpawnConfigBuilder` asks this module and holds no role logic.
 */

import { readFileSync } from 'fs';
import { getLogger } from '../../logging/logger';

export type RoleSkippableMcpServer = 'browser' | 'desktop' | 'imap' | 'codemem';

/** The part of an instance the policy reads. */
export interface McpRoleSubject {
  metadata?: Record<string, unknown>;
}

/** Queue roles that do not need the expensive servers. */
const LEAN_QUEUE_ROLES: ReadonlySet<string> = new Set(['verifier', 'triage']);
const NOTHING: ReadonlySet<RoleSkippableMcpServer> = new Set();
const EXPENSIVE: ReadonlySet<RoleSkippableMcpServer> = new Set(['browser', 'desktop', 'imap', 'codemem']);

/** Server names in `config/mcp-servers.json` that belong to a skippable class. */
const STATIC_SERVER_CLASS: Readonly<Record<string, RoleSkippableMcpServer>> = { imap: 'imap' };

/** Servers to leave out for this instance. Unknown or role-less instances skip none. */
export function mcpServersSkippedForRole(
  subject: McpRoleSubject | undefined,
): ReadonlySet<RoleSkippableMcpServer> {
  const role = subject?.metadata?.['planQueueRole'];
  return typeof role === 'string' && LEAN_QUEUE_ROLES.has(role) ? EXPENSIVE : NOTHING;
}

/**
 * What to hand the CLI for the static `config/mcp-servers.json`.
 *
 * Nothing skipped: the file itself, exactly as before (Codex and ACP providers
 * recognise it by name). Otherwise an inline copy without the skipped servers,
 * which every provider's inline-config path already understands. A file that
 * cannot be read or has no servers left yields nothing, as the CLI could not
 * have used it either.
 */
export function staticMcpConfigEntries(
  configPath: string,
  skipped: ReadonlySet<RoleSkippableMcpServer>,
): string[] {
  if (!Object.values(STATIC_SERVER_CLASS).some((server) => skipped.has(server))) {
    return [configPath];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
    const kept = Object.entries(servers).filter(([name]) => {
      const server = STATIC_SERVER_CLASS[name];
      return server === undefined || !skipped.has(server);
    });
    return kept.length > 0 ? [JSON.stringify({ mcpServers: Object.fromEntries(kept) })] : [];
  } catch {
    // Parse errors may contain file contents; log the affected path only.
    getLogger('McpRolePolicy').warn('Could not read static MCP config for role filtering', { configPath });
    return [];
  }
}
