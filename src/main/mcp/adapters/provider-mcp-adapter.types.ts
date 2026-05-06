import type {
  ProviderMcpScope,
  SupportedProvider,
} from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';

export interface ProviderScopeSnapshot {
  scope: ProviderMcpScope;
  sourceFile: string;
  servers: readonly RawMcpRecord[];
}

export interface ProviderMcpAdapter {
  readonly provider: SupportedProvider;

  discoverScopes(options: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }>;

  readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot>;

  writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void>;
}
