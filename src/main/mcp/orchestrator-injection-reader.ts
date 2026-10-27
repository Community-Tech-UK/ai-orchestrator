import type { McpInjectionBundle } from '../../shared/types/mcp-orchestrator.types';
import type { OrchestratorRuntimeInjectionProvider } from '../../shared/types/mcp-scopes.types';
import type { OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import { connectorAccessRegistry } from './connector-access';
import { resolveAioMcpCliPath } from '../util/aio-mcp-cli-path';

export interface ConnectorBridgeRuntime {
  command: string;
  socketPath: string;
  capabilityToken: string;
}
function resolveBridge(instanceId: string): ConnectorBridgeRuntime | null {
  // Loaded at spawn, after the parent socket has started.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rpc =
    require('./orchestrator-tools-rpc-server') as typeof import('./orchestrator-tools-rpc-server');
  const command = resolveAioMcpCliPath();
  const socketPath = rpc.getOrchestratorToolsRpcSocketPath();
  const capabilityToken = rpc.getOrchestratorToolsRpcInstanceCapability(instanceId);
  return command && socketPath && capabilityToken ? { command, socketPath, capabilityToken } : null;
}
export class OrchestratorInjectionReader {
  constructor(
    private readonly repo: OrchestratorMcpRepository,
    private readonly bridge = resolveBridge,
  ) {}

  buildBundle(
    provider: OrchestratorRuntimeInjectionProvider,
    instanceId: string,
  ): McpInjectionBundle {
    const entries = this.repo
      .list()
      .filter((entry) => entry.record.autoConnect && entry.injectInto.includes(provider));
    const remote = entries.filter(
      (entry) => entry.record.transport !== 'stdio' || entry.record.kind === 'microsoft365',
    );
    const bridge = remote.length && instanceId ? this.bridge(instanceId) : null;
    if (remote.length && !bridge)
      throw new Error(
        'Connectors need the Harness tool bridge. Rebuild Harness and start the session again.',
      );
    if (instanceId)
      connectorAccessRegistry.grant(
        instanceId,
        remote.map((entry) => entry.record.id),
      );
    return {
      configPaths: [],
      inlineConfigs: entries.map(({ record }) => {
        const config =
          record.transport !== 'stdio' || record.kind === 'microsoft365'
            ? {
                command: bridge!.command,
                args: ['connector', record.name],
                env: {
                  AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: bridge!.socketPath,
                  AI_ORCHESTRATOR_INSTANCE_ID: instanceId!,
                  AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: bridge!.capabilityToken,
                },
              }
            : { command: record.command, args: record.args, env: record.env };
        return JSON.stringify({ mcpServers: { [record.name]: config } });
      }),
    };
  }
}
