import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import type { WriteSafetyHelper } from '../write-safety-helper';
import type { ProviderMcpAdapter, ProviderScopeSnapshot } from './provider-mcp-adapter.types';
import {
  getOpenCodeMcpMap,
  normalizeOpenCodeMcpServers,
  openCodeServerNameFromId,
  readOpenCodeMcpDocument,
  serializeOpenCodeMcpRecord,
} from './opencode-mcp-config';

const CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc'] as const;

/**
 * MCP adapter for the OpenCode CLI (`opencode`).
 *
 * User-scope servers live in `opencode.json(c)` under the OpenCode config
 * directory (`~/.config/opencode`); project-scope servers in `opencode.json(c)`
 * at the workspace root. When both filenames exist the `.json` one is
 * preferred. Writes re-serialize the document as plain JSON (comments in a
 * `.jsonc` file are not preserved).
 */
export class OpenCodeMcpAdapter implements ProviderMcpAdapter {
  readonly provider: SupportedProvider = 'opencode';

  constructor(private readonly deps: { home: string; writeSafety: WriteSafetyHelper }) {}

  async discoverScopes(options: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }> {
    return {
      cliAvailable: true,
      scopeFiles: {
        user: this.resolveConfigFile(path.join(this.deps.home, '.config', 'opencode')),
        project: this.resolveConfigFile(options.cwd),
      },
    };
  }

  async readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot> {
    const document = await readOpenCodeMcpDocument(filePath);
    return {
      scope,
      sourceFile: filePath,
      servers: normalizeOpenCodeMcpServers(this.provider, scope, getOpenCodeMcpMap(document)),
    };
  }

  async writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void> {
    const document = await readOpenCodeMcpDocument(op.sourceFile);
    const mcp = { ...getOpenCodeMcpMap(document) };
    if (op.kind === 'upsert') {
      mcp[op.record.name] = serializeOpenCodeMcpRecord(op.record);
    } else {
      delete mcp[openCodeServerNameFromId(op.serverId)];
    }
    await this.deps.writeSafety.writeAtomic(
      op.sourceFile,
      JSON.stringify({ ...document, mcp }, null, 2),
    );
  }

  private resolveConfigFile(directory: string): string {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return path.join(directory, CONFIG_FILENAMES[0]);
  }
}
