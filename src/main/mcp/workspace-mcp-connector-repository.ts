import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { McpTransport } from '../../shared/types/mcp-orchestrator.types';
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { WorkspaceMcpConnectorRecord } from '../../shared/types/workspace-mcp-connector.types';
import type { McpSecretStorage } from './secret-storage';
import {
  hydrateEnvFromStorage,
  parseJson,
  splitEnvForStorage,
  stringifyJson,
} from './mcp-record-storage';
import { isWorkspaceSecretRef } from './reject-workspace-secret-ref';

interface WorkspaceMcpConnectorRow {
  id: string;
  workspace_id: string;
  provider: SupportedProvider;
  name: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  args_json: string | null;
  url: string | null;
  headers_json: string | null;
  headers_secrets_encrypted_json: string | null;
  env_json: string | null;
  env_secrets_encrypted_json: string | null;
  created_at: number;
  updated_at: number;
}

export type WorkspaceMcpConnectorUpsertInput = Partial<WorkspaceMcpConnectorRecord> & {
  workspaceId: string;
  provider: SupportedProvider;
  name: string;
  transport: McpTransport;
};

/**
 * Persist workspace-bound MCP connectors. `secret://` env values stay as
 * opaque refs in public JSON; ordinary sensitive fields use MCP encryption.
 */
export class WorkspaceMcpConnectorRepository {
  constructor(
    private readonly db: SqliteDriver,
    private readonly secrets: McpSecretStorage,
  ) {}

  list(workspaceId: string, provider?: SupportedProvider): WorkspaceMcpConnectorRecord[] {
    const rows = provider
      ? this.db.prepare(`
          SELECT * FROM workspace_mcp_connectors
          WHERE workspace_id = ? AND provider = ?
          ORDER BY name COLLATE NOCASE ASC
        `).all<WorkspaceMcpConnectorRow>(workspaceId, provider)
      : this.db.prepare(`
          SELECT * FROM workspace_mcp_connectors
          WHERE workspace_id = ?
          ORDER BY provider, name COLLATE NOCASE ASC
        `).all<WorkspaceMcpConnectorRow>(workspaceId);
    return rows.map((row) => this.fromRow(row));
  }

  get(id: string): WorkspaceMcpConnectorRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workspace_mcp_connectors WHERE id = ?')
      .get<WorkspaceMcpConnectorRow>(id);
    return row ? this.fromRow(row) : null;
  }

  upsert(input: WorkspaceMcpConnectorUpsertInput): WorkspaceMcpConnectorRecord {
    const existing = input.id ? this.get(input.id) : null;
    const now = Date.now();
    const transport = input.transport ?? existing?.transport ?? 'stdio';
    const record: WorkspaceMcpConnectorRecord = {
      id: input.id ?? existing?.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider,
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
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    const headers = splitEnvForStorage(record.headers, this.secrets);
    const env = splitConnectorEnvForStorage(record.env, this.secrets);
    this.db.prepare(`
      INSERT INTO workspace_mcp_connectors (
        id, workspace_id, provider, name, description, transport, command, args_json, url,
        headers_json, headers_secrets_encrypted_json, env_json, env_secrets_encrypted_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        provider = excluded.provider,
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
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.workspaceId,
      record.provider,
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
      record.createdAt,
      record.updatedAt,
    );
    return this.get(record.id)!;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM workspace_mcp_connectors WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private fromRow(row: WorkspaceMcpConnectorRow): WorkspaceMcpConnectorRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      provider: row.provider,
      name: row.name,
      description: row.description ?? undefined,
      transport: row.transport,
      command: row.command ?? undefined,
      args: parseJson<string[]>(row.args_json, []),
      url: row.url ?? undefined,
      headers: hydrateEnvFromStorage(
        row.headers_json,
        row.headers_secrets_encrypted_json,
        this.secrets,
      ),
      env: hydrateEnvFromStorage(row.env_json, row.env_secrets_encrypted_json, this.secrets),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/** Keep `secret://` refs in public JSON; encrypt only ordinary sensitive values. */
export function splitConnectorEnvForStorage(
  env: Record<string, string> | undefined,
  secrets: McpSecretStorage,
): { publicJson: string | null; secretsJson: string | null } {
  if (!env || Object.keys(env).length === 0) {
    return { publicJson: null, secretsJson: null };
  }
  const refs: Record<string, string> = {};
  const remainder: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isWorkspaceSecretRef(value)) {
      refs[key] = value.trim();
    } else {
      remainder[key] = value;
    }
  }
  const split = splitEnvForStorage(remainder, secrets);
  const publicRecord = {
    ...parseJson<Record<string, string>>(split.publicJson, {}),
    ...refs,
  };
  return {
    publicJson: Object.keys(publicRecord).length > 0 ? JSON.stringify(publicRecord) : null,
    secretsJson: split.secretsJson,
  };
}
