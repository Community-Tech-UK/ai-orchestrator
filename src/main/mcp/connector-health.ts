import type { OrchestratorMcpServer } from '../../shared/types/mcp-orchestrator.types';
import type { ConnectorAuthService } from './connector-auth-service';
import { connectRemoteConnector } from './connector-remote-client';

export async function listConnectorTools(
  record: OrchestratorMcpServer,
  auth: Pick<ConnectorAuthService, 'getAccessToken'>,
) {
  if (record.kind === 'microsoft365') {
    const { getGraphConnectorService } = await import('../graph/graph-connector-service');
    const graph = getGraphConnectorService();
    try {
      await graph.testConnection(record.accountId!, record.mailEnabled);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'reauth_required') {
        throw new Error(`Sign in to ${record.name} again in Settings → Connectors.`, { cause: error });
      }
      throw error;
    }
    return graph.listTools(record.accountId!, record.mailEnabled);
  }
  if (!record.url) throw new Error('Use the tool server Test action for local programs.');
  const client = await connectRemoteConnector(async (forceRefresh) => ({
    url: record.url!,
    headers: record.headers,
    transport: record.transport,
    accessToken: await auth.getAccessToken(record.id, forceRefresh),
  }));
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}
