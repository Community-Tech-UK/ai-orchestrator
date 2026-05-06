import type { OrchestratorMcpScope, SupportedProvider } from './mcp-scopes.types';

export type McpTransport = 'stdio' | 'sse' | 'http';

export interface OrchestratorMcpServer {
  id: string;
  name: string;
  description?: string;
  scope: OrchestratorMcpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  envSecretsEncrypted?: Record<string, string>;
  autoConnect: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorInjectionTargets {
  serverId: string;
  providers: readonly SupportedProvider[];
}

export interface McpInjectionBundle {
  configPaths: readonly string[];
  inlineConfigs: readonly string[];
}
