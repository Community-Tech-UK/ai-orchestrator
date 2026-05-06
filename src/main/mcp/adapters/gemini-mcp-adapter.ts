import * as path from 'node:path';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import type { WriteSafetyHelper } from '../write-safety-helper';
import type { ProviderMcpAdapter, ProviderScopeSnapshot } from './provider-mcp-adapter.types';
import {
  getMcpServerMap,
  normalizeJsonMcpServers,
  readJsonMcpDocument,
  serializeJsonMcpRecord,
  serverNameFromId,
} from './json-mcp-config';

export class GeminiMcpAdapter implements ProviderMcpAdapter {
  readonly provider: SupportedProvider = 'gemini';

  constructor(private readonly deps: { home: string; writeSafety: WriteSafetyHelper }) {}

  async discoverScopes(_options: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }> {
    return {
      cliAvailable: true,
      scopeFiles: { user: path.join(this.deps.home, '.gemini', 'settings.json') },
    };
  }

  async readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot> {
    const document = await readJsonMcpDocument(filePath);
    return {
      scope,
      sourceFile: filePath,
      servers: normalizeJsonMcpServers(this.provider, scope, getMcpServerMap(document)),
    };
  }

  async writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void> {
    const document = await readJsonMcpDocument(op.sourceFile);
    const mcpServers = { ...getMcpServerMap(document) };
    if (op.kind === 'upsert') {
      mcpServers[op.record.name] = serializeJsonMcpRecord(op.record);
    } else {
      delete mcpServers[serverNameFromId(op.serverId)];
    }
    await this.deps.writeSafety.writeAtomic(
      op.sourceFile,
      JSON.stringify({ ...document, mcpServers }, null, 2),
    );
  }
}
