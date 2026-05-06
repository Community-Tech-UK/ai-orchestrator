import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { SharedMcpRecord } from '../../shared/types/mcp-shared.types';
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { McpSecretStorage } from './secret-storage';
import {
  ensureMcpTables,
  hydrateEnvFromStorage,
  parseJson,
  splitEnvForStorage,
  stringifyJson,
} from './mcp-record-storage';

interface SharedMcpRow {
  id: string;
  name: string;
  description: string | null;
  transport: SharedMcpRecord['transport'];
  command: string | null;
  args_json: string | null;
  url: string | null;
  headers_json: string | null;
  headers_secrets_encrypted_json: string | null;
  env_json: string | null;
  env_secrets_encrypted_json: string | null;
  targets_json: string;
  created_at: number;
  updated_at: number;
}

export class SharedMcpRepository {
  constructor(
    private readonly db: SqliteDriver,
    private readonly secrets: McpSecretStorage,
  ) {
    ensureMcpTables(db);
  }

  list(): SharedMcpRecord[] {
    return this.db
      .prepare('SELECT * FROM shared_mcp_servers ORDER BY name COLLATE NOCASE ASC')
      .all<SharedMcpRow>()
      .map((row) => this.fromRow(row));
  }

  get(id: string): SharedMcpRecord | null {
    const row = this.db
      .prepare('SELECT * FROM shared_mcp_servers WHERE id = ?')
      .get<SharedMcpRow>(id);
    return row ? this.fromRow(row) : null;
  }

  upsert(input: Partial<SharedMcpRecord> & {
    name: string;
    targets: readonly SupportedProvider[];
  }): SharedMcpRecord {
    const existing = input.id ? this.get(input.id) : null;
    const now = Date.now();
    const transport = input.transport ?? existing?.transport ?? 'stdio';
    const record: SharedMcpRecord = {
      id: input.id ?? existing?.id ?? randomUUID(),
      name: input.name,
      description: input.description ?? existing?.description,
      transport,
      command: transport === 'stdio' ? input.command ?? existing?.command : undefined,
      args: transport === 'stdio' ? input.args ?? existing?.args : undefined,
      url: transport !== 'stdio' ? input.url ?? existing?.url : undefined,
      headers: input.headers
        ? { ...(existing?.headers ?? {}), ...input.headers }
        : existing?.headers,
      env: input.env
        ? { ...(existing?.env ?? {}), ...input.env }
        : existing?.env,
      targets: input.targets,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    const headers = splitEnvForStorage(record.headers, this.secrets);
    const env = splitEnvForStorage(record.env, this.secrets);
    this.db.prepare(`
      INSERT INTO shared_mcp_servers (
        id, name, description, transport, command, args_json, url, headers_json, headers_secrets_encrypted_json,
        env_json, env_secrets_encrypted_json, targets_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        transport = excluded.transport,
        command = excluded.command,
        args_json = excluded.args_json,
        url = excluded.url,
        headers_json = excluded.headers_json,
        headers_secrets_encrypted_json = excluded.headers_secrets_encrypted_json,
        env_json = excluded.env_json,
        env_secrets_encrypted_json = excluded.env_secrets_encrypted_json,
        targets_json = excluded.targets_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.name,
      record.description ?? null,
      record.transport,
      record.command ?? null,
      stringifyJson(record.args),
      record.url ?? null,
      headers.publicJson,
      headers.secretsJson,
      env.publicJson,
      env.secretsJson,
      stringifyJson(record.targets),
      record.createdAt,
      record.updatedAt,
    );
    return this.get(record.id)!;
  }

  delete(serverId: string): void {
    this.db.prepare('DELETE FROM shared_mcp_servers WHERE id = ?').run(serverId);
  }

  private fromRow(row: SharedMcpRow): SharedMcpRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      transport: row.transport,
      command: row.command ?? undefined,
      args: parseJson<string[]>(row.args_json, []),
      url: row.url ?? undefined,
      headers: hydrateEnvFromStorage(row.headers_json, row.headers_secrets_encrypted_json, this.secrets),
      env: hydrateEnvFromStorage(row.env_json, row.env_secrets_encrypted_json, this.secrets),
      targets: parseJson<SupportedProvider[]>(row.targets_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
