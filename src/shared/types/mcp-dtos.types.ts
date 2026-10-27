import type { McpTransport } from './mcp-orchestrator.types';
import type { McpScope, SupportedProvider, OrchestratorRuntimeInjectionProvider } from './mcp-scopes.types';

export const REDACTED_SENTINEL = '***';

export interface RedactedMcpServerDto {
  id: string;
  name: string;
  description?: string;
  scope: McpScope;
  transport: McpTransport;
  kind?: 'local' | 'remote' | 'microsoft365';
  authType?: 'none' | 'bearer' | 'oauth';
  clientMetadataUrl?: string;
  accountId?: string;
  mailEnabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  autoConnect: boolean;
  sourceFile?: string;
  readOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderTabDto {
  provider: SupportedProvider;
  cliAvailable: boolean;
  servers: readonly RedactedMcpServerDto[];
}

export interface ConnectorAuthStatus {
  state: 'signed-out' | 'signed-in' | 'not-required' | 'expired';
  message?: string;
}

export interface OrchestratorMcpDto {
  record: Omit<RedactedMcpServerDto, 'scope' | 'readOnly'> & {
    scope: 'orchestrator' | 'orchestrator-bootstrap' | 'orchestrator-codemem';
    readOnly: false;
  };
  injectInto: readonly OrchestratorRuntimeInjectionProvider[];
  authStatus?: ConnectorAuthStatus;
  agentsMayWrite?: boolean;
}

export interface McpMultiProviderStateDto {
  orchestrator: readonly OrchestratorMcpDto[];
  providers: readonly ProviderTabDto[];
  stateVersion: number;
}
