import type { McpTransport } from './mcp-orchestrator.types';
import type { SupportedProvider } from './mcp-scopes.types';

/** Persisted workspace-bound MCP connector. Env may contain `secret://` refs. */
export interface WorkspaceMcpConnectorRecord {
  id: string;
  workspaceId: string;
  provider: SupportedProvider;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** Renderer-facing DTO. Ordinary secrets are redacted; `secret://` refs stay visible. */
export interface WorkspaceMcpConnectorDto {
  id: string;
  workspaceId: string;
  provider: SupportedProvider;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}
