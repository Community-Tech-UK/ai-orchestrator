import type { WorkspaceMcpConnectorDto } from '../../shared/types/workspace-mcp-connector.types';
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import { toSecretWorkspaceId } from '../secrets/secret-workspace-key';
import { isUnscopedWorkspace } from '../secrets/secret-workspace-key';
import { RedactionService } from './redaction-service';
import { SecretClassifier } from './secret-classifier';
import {
  assertWorkspaceSecretRefsOnlyInEnv,
} from './reject-workspace-secret-ref';
import { isWorkspaceSecretRef } from './reject-workspace-secret-ref';
import {
  WorkspaceMcpConnectorRepository,
  type WorkspaceMcpConnectorUpsertInput,
} from './workspace-mcp-connector-repository';

export interface WorkspaceMcpConnectorUpsertPayload {
  id?: string;
  workingDirectory: string;
  provider: SupportedProvider;
  name: string;
  description?: string;
  transport: WorkspaceMcpConnectorUpsertInput['transport'];
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export class WorkspaceMcpConnectorService {
  private readonly redaction = new RedactionService(new SecretClassifier());

  constructor(private readonly repo: WorkspaceMcpConnectorRepository) {}

  list(workingDirectory: string, provider?: SupportedProvider): WorkspaceMcpConnectorDto[] {
    const workspaceId = this.requireWorkspaceId(workingDirectory);
    return this.repo.list(workspaceId, provider).map((record) => this.toDto(record));
  }

  upsert(payload: WorkspaceMcpConnectorUpsertPayload): WorkspaceMcpConnectorDto {
    const workspaceId = this.requireWorkspaceId(payload.workingDirectory);
    assertWorkspaceSecretRefsOnlyInEnv({
      headers: payload.headers,
      url: payload.url,
      args: payload.args,
      command: payload.command,
    });
    const saved = this.repo.upsert({
      id: payload.id,
      workspaceId,
      provider: payload.provider,
      name: payload.name,
      description: payload.description,
      transport: payload.transport,
      command: payload.command,
      args: payload.args,
      url: payload.url,
      headers: payload.headers,
      env: payload.env,
    });
    return this.toDto(saved);
  }

  delete(id: string): boolean {
    return this.repo.delete(id);
  }

  private requireWorkspaceId(workingDirectory: string): string {
    const workspaceId = toSecretWorkspaceId(workingDirectory);
    if (isUnscopedWorkspace(workspaceId)) {
      throw new Error(
        'A workspace MCP connector requires a real working directory; it will not fall back to a global MCP scope',
      );
    }
    return workspaceId;
  }

  private toDto(
    record: ReturnType<WorkspaceMcpConnectorRepository['upsert']>,
  ): WorkspaceMcpConnectorDto {
    const redacted = this.redaction.redact(
      {
        id: record.id,
        name: record.name,
        description: record.description,
        transport: record.transport,
        command: record.command,
        args: record.args,
        url: record.url,
        headers: record.headers,
        env: record.env,
        autoConnect: false,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      { scope: 'workspace', readOnly: false },
    );
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      provider: record.provider,
      name: record.name,
      description: record.description,
      transport: record.transport,
      command: record.command,
      args: record.args,
      url: redacted.url,
      headers: redacted.headers,
      env: keepSecretRefsVisible(record.env, redacted.env),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

function keepSecretRefsVisible(
  raw: Record<string, string> | undefined,
  redacted: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!raw && !redacted) {
    return undefined;
  }
  const merged = { ...(redacted ?? {}) };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (isWorkspaceSecretRef(value)) {
      merged[key] = value.trim();
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
