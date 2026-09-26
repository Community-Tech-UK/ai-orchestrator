/**
 * `session/new` / `session/load` MCP-server filtering by the agent's advertised
 * `agentCapabilities.mcpCapabilities` (agent-client-protocol, "Checking
 * Transport Support"): clients MUST verify HTTP/SSE support during
 * initialization before sending those entries. stdio is mandatory for every
 * agent and always passes.
 */

import type { AcpAgentCapabilities, AcpMcpServerConfig } from '../../../shared/types/cli.types';

export interface FilteredSessionMcpServers {
  servers: AcpMcpServerConfig[];
  dropped: Array<{ name: string; remoteType: 'http' | 'sse' }>;
}

export function filterSessionMcpServers(
  servers: readonly AcpMcpServerConfig[],
  capabilities: AcpAgentCapabilities | null | undefined,
): FilteredSessionMcpServers {
  const kept: AcpMcpServerConfig[] = [];
  const dropped: FilteredSessionMcpServers['dropped'] = [];
  for (const server of servers) {
    if (server.type === 'http' && capabilities?.mcpCapabilities?.http !== true) {
      dropped.push({ name: server.name, remoteType: 'http' });
      continue;
    }
    if (server.type === 'sse' && capabilities?.mcpCapabilities?.sse !== true) {
      dropped.push({ name: server.name, remoteType: 'sse' });
      continue;
    }
    kept.push(server);
  }
  return { servers: kept, dropped };
}
