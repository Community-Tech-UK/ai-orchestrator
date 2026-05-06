import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { OrchestratorMcpScope, SupportedProvider } from '../../shared/types/mcp-scopes.types';
import { ORCHESTRATOR_INJECTION_PROVIDERS } from '../../shared/types/mcp-scopes.types';
import type { OrchestratorMcpServer } from '../../shared/types/mcp-orchestrator.types';
import type { McpSecretStorage } from './secret-storage';
import {
  ensureMcpTables,
  hydrateEnvFromStorage,
  parseJson,
  splitEnvForStorage,
  stringifyJson,
} from './mcp-record-storage';

interface OrchestratorMcpRow {
  id: string;
  name: string;
  description: string | null;
  scope: OrchestratorMcpScope;
  transport: OrchestratorMcpServer['transport'];
  command: string | null;
  args_json: string | null;
  url: string | null;
  headers_json: string | null;
  headers_secrets_encrypted_json: string | null;
  env_json: string | null;
  env_secrets_encrypted_json: string | null;
  auto_connect: number;
  inject_into_json: string;
  created_at: number;
  updated_at: number;
}

export interface OrchestratorMcpRecordWithTargets {
  record: OrchestratorMcpServer;
  injectInto: readonly SupportedProvider[];
}

export class OrchestratorMcpRepository {
  constructor(
    private readonly db: SqliteDriver,
    private readonly secrets: McpSecretStorage,
  ) {
    ensureMcpTables(db);
  }

  list(): OrchestratorMcpRecordWithTargets[] {
    return this.db
      .prepare('SELECT * FROM orchestrator_mcp_servers ORDER BY name COLLATE NOCASE ASC')
      .all<OrchestratorMcpRow>()
      .map((row) => this.fromRow(row));
  }

  get(id: string): OrchestratorMcpRecordWithTargets | null {
    const row = this.db
      .prepare('SELECT * FROM orchestrator_mcp_servers WHERE id = ?')
      .get<OrchestratorMcpRow>(id);
    return row ? this.fromRow(row) : null;
  }

  upsert(input: Partial<OrchestratorMcpServer> & {
    name: string;
    scope?: OrchestratorMcpScope;
    injectInto?: readonly SupportedProvider[];
  }): OrchestratorMcpRecordWithTargets {
    const existing = input.id ? this.get(input.id) : null;
    const now = Date.now();
    const transport = input.transport ?? existing?.record.transport ?? 'stdio';
    const record: OrchestratorMcpServer = {
      id: input.id ?? existing?.record.id ?? randomUUID(),
      name: input.name,
      description: input.description ?? existing?.record.description,
      scope: input.scope ?? existing?.record.scope ?? 'orchestrator',
      transport,
      command: transport === 'stdio' ? input.command ?? existing?.record.command : undefined,
      args: transport === 'stdio' ? input.args ?? existing?.record.args : undefined,
      url: transport !== 'stdio' ? input.url ?? existing?.record.url : undefined,
      headers: input.headers
        ? { ...(existing?.record.headers ?? {}), ...input.headers }
        : existing?.record.headers,
      env: input.env
        ? { ...(existing?.record.env ?? {}), ...input.env }
        : existing?.record.env,
      autoConnect: input.autoConnect ?? existing?.record.autoConnect ?? true,
      createdAt: existing?.record.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    const injectInto = normalizeInjectionTargets(
      input.injectInto ?? existing?.injectInto ?? ORCHESTRATOR_INJECTION_PROVIDERS,
    );
    const headers = splitEnvForStorage(record.headers, this.secrets);
    const env = splitEnvForStorage(record.env, this.secrets);
    this.db.prepare(`
      INSERT INTO orchestrator_mcp_servers (
        id, name, description, scope, transport, command, args_json, url, headers_json, headers_secrets_encrypted_json,
        env_json, env_secrets_encrypted_json, auto_connect, inject_into_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        scope = excluded.scope,
        transport = excluded.transport,
        command = excluded.command,
        args_json = excluded.args_json,
        url = excluded.url,
        headers_json = excluded.headers_json,
        headers_secrets_encrypted_json = excluded.headers_secrets_encrypted_json,
        env_json = excluded.env_json,
        env_secrets_encrypted_json = excluded.env_secrets_encrypted_json,
        auto_connect = excluded.auto_connect,
        inject_into_json = excluded.inject_into_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.name,
      record.description ?? null,
      record.scope,
      record.transport,
      record.command ?? null,
      stringifyJson(record.args),
      record.url ?? null,
      headers.publicJson,
      headers.secretsJson,
      env.publicJson,
      env.secretsJson,
      record.autoConnect ? 1 : 0,
      stringifyJson(injectInto),
      record.createdAt,
      record.updatedAt,
    );
    return this.get(record.id)!;
  }

  setInjectionTargets(serverId: string, providers: readonly SupportedProvider[]): void {
    this.db
      .prepare('UPDATE orchestrator_mcp_servers SET inject_into_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(normalizeInjectionTargets(providers)), Date.now(), serverId);
  }

  delete(serverId: string): void {
    this.db.prepare('DELETE FROM orchestrator_mcp_servers WHERE id = ?').run(serverId);
  }

  private fromRow(row: OrchestratorMcpRow): OrchestratorMcpRecordWithTargets {
    return {
      record: {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        scope: row.scope,
        transport: row.transport,
        command: row.command ?? undefined,
        args: parseJson<string[]>(row.args_json, []),
        url: row.url ?? undefined,
        headers: hydrateEnvFromStorage(row.headers_json, row.headers_secrets_encrypted_json, this.secrets),
        env: hydrateEnvFromStorage(row.env_json, row.env_secrets_encrypted_json, this.secrets),
        autoConnect: row.auto_connect === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      injectInto: normalizeInjectionTargets(
        parseJson<SupportedProvider[]>(row.inject_into_json, [...ORCHESTRATOR_INJECTION_PROVIDERS]),
      ),
    };
  }
}

function normalizeInjectionTargets(providers: readonly SupportedProvider[]): SupportedProvider[] {
  return providers.filter((provider) =>
    ORCHESTRATOR_INJECTION_PROVIDERS.includes(provider)
  );
}
