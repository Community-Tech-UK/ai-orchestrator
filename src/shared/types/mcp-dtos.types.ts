import type { McpTransport } from './mcp-orchestrator.types';
import type { McpScope, SupportedProvider } from './mcp-scopes.types';
import type { DriftState } from './mcp-shared.types';

export const REDACTED_SENTINEL = '***';

export interface RedactedMcpServerDto {
  id: string;
  name: string;
  description?: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  autoConnect: boolean;
  sourceFile?: string;
  readOnly: boolean;
  sharedTargets?: readonly SupportedProvider[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderTabDto {
  provider: SupportedProvider;
  cliAvailable: boolean;
  servers: readonly RedactedMcpServerDto[];
}

export interface SharedMcpDto {
  record: Omit<RedactedMcpServerDto, 'scope' | 'readOnly'> & {
    scope: 'shared';
    readOnly: false;
  };
  targets: readonly {
    provider: SupportedProvider;
    state: DriftState;
    diff?: string;
    lastObservedAt?: number;
  }[];
}

export interface OrchestratorMcpDto {
  record: Omit<RedactedMcpServerDto, 'scope' | 'readOnly'> & {
    scope: 'orchestrator' | 'orchestrator-bootstrap' | 'orchestrator-codemem';
    readOnly: false;
  };
  injectInto: readonly SupportedProvider[];
}

export interface McpMultiProviderStateDto {
  orchestrator: readonly OrchestratorMcpDto[];
  shared: readonly SharedMcpDto[];
  providers: readonly ProviderTabDto[];
  stateVersion: number;
}

export interface SharedDriftStatusDto {
  provider: SupportedProvider;
  state: DriftState;
  diff?: string;
  lastObservedAt: number;
}
