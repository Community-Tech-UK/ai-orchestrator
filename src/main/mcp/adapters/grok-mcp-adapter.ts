import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import type { WriteSafetyHelper } from '../write-safety-helper';
import type { ProviderMcpAdapter, ProviderScopeSnapshot } from './provider-mcp-adapter.types';
import { CodexTomlEditor } from './codex-toml-editor';
import { serverNameFromId } from './json-mcp-config';

/**
 * MCP adapter for Grok Build (`grok`).
 *
 * Grok stores MCP servers as `[mcp_servers.<name>]` TOML tables in
 * `~/.grok/config.toml` (user scope) and `.grok/config.toml` (project scope;
 * the Grok CLI itself walks project configs from the working directory up to
 * the repo root — this adapter surfaces the working-directory file). The shape
 * is the same as Codex's `~/.codex/config.toml`, so the same TOML editor is
 * used — see the Grok Build README, "MCP Servers". Writes place `env`/`headers`
 * as TOML sub-tables (`[mcp_servers.<name>.env]`), semantically identical to
 * the README's inline `env = { ... }` form.
 */
export class GrokMcpAdapter implements ProviderMcpAdapter {
  readonly provider: SupportedProvider = 'grok';
  private readonly editor = new CodexTomlEditor();

  constructor(private readonly deps: { home: string; writeSafety: WriteSafetyHelper }) {}

  async discoverScopes(options: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }> {
    return {
      cliAvailable: true,
      scopeFiles: {
        user: path.join(this.deps.home, '.grok', 'config.toml'),
        project: path.join(options.cwd, '.grok', 'config.toml'),
      },
    };
  }

  async readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot> {
    const raw = fs.existsSync(filePath) ? await fsp.readFile(filePath, 'utf8') : '';
    const now = Date.now();
    const servers = Object.entries(this.editor.parseMcpServers(raw)).map(([name, entry]) => ({
      id: `${this.provider}:${scope}:${name}`,
      name,
      description: entry.description,
      transport: entry.transport ?? (entry.url ? 'sse' as const : 'stdio' as const),
      command: entry.command,
      args: entry.args,
      url: entry.url,
      headers: entry.headers,
      env: entry.env,
      autoConnect: entry.enabled !== false,
      createdAt: now,
      updatedAt: now,
    }));
    return { scope, sourceFile: filePath, servers };
  }

  async writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void> {
    const current = fs.existsSync(op.sourceFile) ? await fsp.readFile(op.sourceFile, 'utf8') : '';
    const next = op.kind === 'upsert'
      ? this.editor.upsertMcpServer(current, op.record.name, this.editor.toCodexServer(op.record))
      : this.editor.deleteMcpServer(current, serverNameFromId(op.serverId));
    await this.deps.writeSafety.writeAtomic(op.sourceFile, next);
  }
}
