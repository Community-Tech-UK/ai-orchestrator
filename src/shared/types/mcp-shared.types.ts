import type { McpTransport } from './mcp-orchestrator.types';
import type { SupportedProvider } from './mcp-scopes.types';

export const DRIFT_STATES = ['in-sync', 'drifted', 'missing', 'not-installed'] as const;
export type DriftState = (typeof DRIFT_STATES)[number];

export interface SharedMcpRecord {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  envSecretsEncrypted?: Record<string, string>;
  targets: readonly SupportedProvider[];
  createdAt: number;
  updatedAt: number;
}

export interface SharedMcpTargetStatus {
  provider: SupportedProvider;
  state: DriftState;
  diff?: string;
  divergentConfig?: string;
  lastObservedAt?: number;
}

export interface SharedMcpServerWithStatus {
  record: SharedMcpRecord;
  targets: readonly SharedMcpTargetStatus[];
}
