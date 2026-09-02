import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import { isSupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { WorkspaceMcpConnectorRecord } from '../../shared/types/workspace-mcp-connector.types';
import { getLogger } from '../logging/logger';
import { isUnscopedWorkspace, toSecretWorkspaceId } from '../secrets/secret-workspace-key';
import { getWorkspaceSecretStore } from '../secrets/workspace-secret-store';
import { isWorkspaceSecretRef } from './reject-workspace-secret-ref';
import type { WorkspaceMcpConnectorRepository } from './workspace-mcp-connector-repository';

const logger = getLogger('WorkspaceMcpConnectorMaterialize');

export interface MaterializeWorkspaceMcpConnectorsInput {
  executionLocation?: ExecutionLocation;
  workingDirectory?: string;
  provider?: string;
  instanceId?: string;
  enabled: boolean;
  repository: WorkspaceMcpConnectorRepository;
  resolveSecret?: (
    ref: string,
    opts: { workspaceId: string; purpose: string; instanceId?: string },
  ) => string;
}

/**
 * Resolve matching workspace connectors into ephemeral inline MCP JSON.
 * Remote, disabled, unscoped, and mismatched providers produce no configs.
 * A missing or undecryptable `secret://` fails the spawn rather than omitting
 * the server. Plaintext never appears in logs or returned errors.
 */
export function materializeWorkspaceMcpConnectors(
  input: MaterializeWorkspaceMcpConnectorsInput,
): string[] {
  if (input.executionLocation?.type === 'remote') {
    return [];
  }
  if (!input.enabled || !input.workingDirectory || !input.provider) {
    return [];
  }
  if (!isSupportedProvider(input.provider)) {
    return [];
  }
  const workspaceId = toSecretWorkspaceId(input.workingDirectory);
  if (isUnscopedWorkspace(workspaceId)) {
    return [];
  }

  const records = input.repository.list(workspaceId, input.provider);
  const resolveSecret = input.resolveSecret
    ?? ((ref, opts) => getWorkspaceSecretStore().resolve(ref, opts));
  return records.map((record) => buildInlineConfig(
    record,
    workspaceId,
    input.instanceId,
    resolveSecret,
  ));
}

function buildInlineConfig(
  record: WorkspaceMcpConnectorRecord,
  workspaceId: string,
  instanceId: string | undefined,
  resolveSecret: (
    ref: string,
    opts: { workspaceId: string; purpose: string; instanceId?: string },
  ) => string,
): string {
  const env = resolveConnectorEnv(record, workspaceId, instanceId, resolveSecret);
  return JSON.stringify({
    mcpServers: {
      [record.name]: {
        transport: record.transport === 'stdio' ? undefined : record.transport,
        command: record.command,
        args: record.args,
        url: record.url,
        headers: record.headers,
        env,
      },
    },
  });
}

function resolveConnectorEnv(
  record: WorkspaceMcpConnectorRecord,
  workspaceId: string,
  instanceId: string | undefined,
  resolveSecret: (
    ref: string,
    opts: { workspaceId: string; purpose: string; instanceId?: string },
  ) => string,
): Record<string, string> | undefined {
  if (!record.env) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.env)) {
    if (!isWorkspaceSecretRef(value)) {
      resolved[key] = value;
      continue;
    }
    try {
      resolved[key] = resolveSecret(value, {
        workspaceId,
        purpose: 'workspace-mcp-connector',
        instanceId,
      });
    } catch (error) {
      logger.warn('Workspace MCP connector secret resolve failed', {
        connectorId: record.id,
        provider: record.provider,
        envKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Workspace MCP connector "${record.name}" could not resolve env ${key}`,
      );
    }
  }
  return resolved;
}
