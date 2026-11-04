import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { OrchestratorRuntimeInjectionProvider } from '../../shared/types/mcp-scopes.types';
import { getMainEventBus } from '../event-bus/main-event-bus';
import { getGraphConnectorService } from '../graph/graph-connector-service';
import { assertConnectorName } from './connector-storage';
import { getCliMcpConfigService, getOrchestratorMcpRepository } from './mcp-multi-provider-singletons';

export interface AddMicrosoft365ConnectorInput {
  name: string;
  mailEnabled: boolean;
  injectInto?: readonly OrchestratorRuntimeInjectionProvider[];
}

export interface AddedMicrosoft365Connector {
  name: string;
  username: string;
  mailEnabled: boolean;
  agentsMayWrite: boolean;
}

/** Fails before any sign-in starts, so nobody completes Microsoft consent for a connector that cannot be saved. */
export function assertMicrosoft365ConnectorNameAvailable(name: string): void {
  assertConnectorName(name);
  if (getOrchestratorMcpRepository().list().some(({ record }) => record.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('A connector already uses that name. Choose a different name before signing in.');
  }
}

/**
 * Signs in one Microsoft 365 account and saves it as a connector. Shared by the
 * Connectors screen and `aio-mcp microsoft365 add`, which asks the operator first.
 */
export async function addMicrosoft365Connector(input: AddMicrosoft365ConnectorInput): Promise<AddedMicrosoft365Connector> {
  assertMicrosoft365ConnectorNameAvailable(input.name);
  const graph = getGraphConnectorService();
  const account = await graph.connectAccount(input.mailEnabled);
  const config = getCliMcpConfigService();
  config.orchestratorUpsert({
    name: input.name, kind: 'microsoft365', accountId: account.accountKey,
    description: account.username, transport: 'stdio', authType: 'none',
    mailEnabled: input.mailEnabled, injectInto: input.injectInto, autoConnect: true,
  });
  getMainEventBus().emitRendererEvent(IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED, await config.getMultiProviderState());
  return {
    name: input.name,
    username: account.username,
    mailEnabled: input.mailEnabled,
    agentsMayWrite: await graph.isWritable(account.accountKey),
  };
}
