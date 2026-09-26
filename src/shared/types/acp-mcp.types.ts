/**
 * ACP `session/new` / `session/load` MCP server entry (agent-client-protocol,
 * "MCP Servers"). stdio is name/command/args/env; remote HTTP/SSE is
 * type/url/headers (the headers array is required by the protocol even when
 * empty). Remote entries are only sendable to agents advertising
 * `agentCapabilities.mcpCapabilities.http` / `.sse` — see
 * src/main/cli/adapters/acp-session-mcp-servers.ts.
 */
export interface AcpMcpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  type?: 'http' | 'sse';
  url?: string;
  headers?: Array<{ name: string; value: string }>;
}
